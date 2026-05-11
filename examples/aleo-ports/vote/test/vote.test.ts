// Port of tmp/leo-examples/vote/. Upstream run.sh isn't checked in; the
// canonical flow per src/main.leo is propose → new_ticket → agree/disagree.
// The proposal id is derived inside propose via BHP256::hash_to_field(title),
// so the test pulls it off a typed Proposal record returned from local mode.
//
// IMPORTANT: in lionden, onchain execution currently returns
// `outputs: []` (see packages/network/src/connection.ts:294 TODO). For
// transitions that BOTH return a record AND have a finalize, we run twice:
//   - local mode → captures plaintext outputs (records, structs, primitives)
//   - accepted() → fires finalize, has side effects
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
} from "@lionden/testing";
import { createVote } from "../typechain/Vote.js";
import { Leo, type LeoField } from "../typechain/BaseContract.js";

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

describe("vote.aleo", () => {
  const vote = createVote();
  const proposer = () => ctx!.accounts[0]!;
  const voter = () => ctx!.accounts[1]!;

  beforeAll(() => {
    vote.connect(ctx!.lre);
  });

  // Captured during propose() so downstream tests can target the right pid.
  let pid: LeoField | undefined;

  it("propose() registers a new proposal and initializes its ticket count", async () => {
    const info = {
      title: Leo.field("11111111field"),
      content: Leo.field("22222222field"),
      proposer: Leo.address(proposer()),
    };

    // Local: capture the typed Proposal record so we can read pid.
    const [proposal] = await vote.withSigner(proposer()).propose.locally({ info });
    pid = proposal.id;

    // Broadcast: actually fire the finalize so tickets[pid] is set to 0.
    await vote.withSigner(proposer()).propose.accepted({ info });

    expect(await vote.getTickets(pid)).toBe(0n);
  });

  it("new_ticket() increments tickets[pid]", async () => {
    expect(pid, "propose() must run first").toBeDefined();
    await vote.new_ticket.accepted({ pid: pid!, voter: voter() });
    expect(await vote.getTickets(pid!)).toBe(1n);
  });

  it("agree() increments agree_votes[pid]", async () => {
    expect(pid).toBeDefined();
    // Issue a Ticket plaintext (local mode → no mapping side effect on tickets).
    const [ticket] = await vote.new_ticket.locally({ pid: pid!, voter: voter() });

    await vote.withSigner(voter()).agree.accepted({ ticket });
    expect(await vote.getAgree_votes(pid!)).toBe(1n);
  });

  it("disagree() increments disagree_votes[pid]", async () => {
    expect(pid).toBeDefined();
    const [ticket] = await vote.new_ticket.locally({ pid: pid!, voter: voter() });

    await vote.withSigner(voter()).disagree.accepted({ ticket });
    expect(await vote.getDisagree_votes(pid!)).toBe(1n);
  });
});
