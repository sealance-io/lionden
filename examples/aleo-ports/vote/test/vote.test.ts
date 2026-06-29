// Port of tmp/leo-examples/vote/. Upstream run.sh isn't checked in; the
// canonical flow per src/main.leo is propose → new_ticket → agree/disagree.
// The proposal id is derived inside propose via BHP256::hash_to_field(title),
// so the test reads it off the accepted Proposal record after decryption.
//
// Transitions that finalize on chain are exercised through a single
// .accepted() call, recovering record outputs (Proposal pid, spendable Ticket)
// via confirmed.outputs.decrypt(...). Proving needs the on-chain state paths,
// so we don't pre-run them in local mode.

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Leo, type LeoField } from "../typechain/BaseContract.js";
import { createVote } from "../typechain/Vote.js";

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
      title: 11111111n,
      content: 22222222n,
      proposer: Leo.address(proposer()),
    };

    // Broadcast fires the finalize so tickets[pid] is set to 0; the Proposal
    // record carries the pid derived inside the program.
    const confirmed = await vote.withSigner(proposer()).propose.accepted({ arg0: info });
    const proposal = await confirmed.outputs.decrypt(proposer());
    pid = proposal.id;

    expect(await vote.mappings.tickets.get(pid)).toBe(0n);
  });

  it("new_ticket() increments tickets[pid]", async () => {
    expect(pid, "propose() must run first").toBeDefined();
    await vote.new_ticket.accepted({ arg0: pid!, arg1: voter() });
    expect(await vote.mappings.tickets.get(pid!)).toBe(1n);
  });

  it("agree() increments agree_votes[pid]", async () => {
    expect(pid).toBeDefined();
    // Spendable ticket comes off the accepted new_ticket transition so the
    // proven agree transition can resolve its on-chain state path.
    const confirmed = await vote.new_ticket.accepted({ arg0: pid!, arg1: voter() });
    const ticket = await confirmed.outputs.decrypt(voter());

    await vote.withSigner(voter()).agree.accepted({ arg0: ticket });
    expect(await vote.mappings.agreeVotes.get(pid!)).toBe(1n);
  });

  it("disagree() increments disagree_votes[pid]", async () => {
    expect(pid).toBeDefined();
    const confirmed = await vote.new_ticket.accepted({ arg0: pid!, arg1: voter() });
    const ticket = await confirmed.outputs.decrypt(voter());

    await vote.withSigner(voter()).disagree.accepted({ arg0: ticket });
    expect(await vote.mappings.disagreeVotes.get(pid!)).toBe(1n);
  });
});
