// Port of tmp/leo-examples/vote/. Upstream run.sh isn't checked in; the
// canonical flow per src/main.leo is propose → new_ticket → agree/disagree.
// The proposal id is derived inside propose via BHP256::hash_to_field(title),
// so the test extracts it from a local-mode Proposal record.
//
// IMPORTANT: in lionden, onchain ctx.execute currently returns
// `outputs: []` (see packages/network/src/connection.ts:294 TODO). For
// transitions that BOTH return a record AND have a finalize, we run twice:
//   - local mode → captures plaintext outputs (records, structs, primitives)
//   - default onchain mode → fires finalize, has side effects
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  assertMappingValue,
  type TestContext,
} from "@lionden/testing";

async function deployVote() {
  const ctx = await setup();
  try {
    await ctx.deploy("vote", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployVote);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

/// Extract the `id: <…>field` field from a Proposal record literal.
function extractProposalId(record: string): string {
  const match = record.match(/id:\s*(\d+field)/);
  if (!match) throw new Error(`could not extract id from: ${record}`);
  return match[1]!;
}

describe("vote.aleo", () => {
  const proposer = () => ctx!.accounts[0]!.address;
  const voter = () => ctx!.accounts[1]!.address;

  // Captured during propose() so downstream tests can target the right pid.
  let pid: string | undefined;

  it("propose() registers a new proposal and initializes its ticket count", async () => {
    const info = `{ title: 11111111field, content: 22222222field, proposer: ${proposer()} }`;

    // Local: capture the Proposal record so we can extract pid.
    const localResult = await ctx!.execute(
      "vote.aleo",
      "propose",
      [info],
      { mode: "local", signer: ctx!.accounts[0]! },
    );
    pid = extractProposalId(localResult.outputs[0]!);

    // Onchain: actually fire the finalize so tickets[pid] is set to 0.
    await ctx!.execute("vote.aleo", "propose", [info], { signer: ctx!.accounts[0]! });

    await assertMappingValue(ctx!.connection, "vote.aleo", "tickets", pid, "0u64");
  });

  it("new_ticket() increments tickets[pid]", async () => {
    expect(pid, "propose() must run first").toBeDefined();
    await ctx!.execute("vote.aleo", "new_ticket", [pid!, voter()]);
    await assertMappingValue(ctx!.connection, "vote.aleo", "tickets", pid!, "1u64");
  });

  it("agree() increments agree_votes[pid]", async () => {
    expect(pid).toBeDefined();
    // Issue a Ticket plaintext (local mode → no mapping side effect on tickets).
    const ticketResult = await ctx!.execute(
      "vote.aleo",
      "new_ticket",
      [pid!, voter()],
      { mode: "local" },
    );
    const ticket = ticketResult.outputs[0]!;

    await ctx!.execute("vote.aleo", "agree", [ticket], { signer: ctx!.accounts[1]! });
    await assertMappingValue(ctx!.connection, "vote.aleo", "agree_votes", pid!, "1u64");
  });

  it("disagree() increments disagree_votes[pid]", async () => {
    expect(pid).toBeDefined();
    const ticketResult = await ctx!.execute(
      "vote.aleo",
      "new_ticket",
      [pid!, voter()],
      { mode: "local" },
    );
    const ticket = ticketResult.outputs[0]!;

    await ctx!.execute("vote.aleo", "disagree", [ticket], { signer: ctx!.accounts[1]! });
    await assertMappingValue(ctx!.connection, "vote.aleo", "disagree_votes", pid!, "1u64");
  });
});
