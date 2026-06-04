// Port of tmp/leo-examples/lottery/. Upstream run.sh just does `leo run play`
// once. The transition itself is deterministic (mints a Ticket); the
// finalize block coinflips via ChaCha::rand_bool() — so onchain calls
// abort ~50% of the time. The port asserts:
//   1. play() in local mode always returns a Ticket (finalize skipped).
//   2. play() onchain either succeeds (mapping num_winners[0u8] = 1) or
//      aborts (mapping stays empty / null). Both outcomes are valid.

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLottery } from "../typechain/Lottery.js";

async function deployLottery() {
  const ctx = await setup();
  try {
    await ctx.deploy("lottery", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployLottery);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("lottery.aleo", () => {
  const lottery = createLottery();

  beforeAll(() => {
    lottery.connect(ctx!.lre);
  });

  it("play() in local mode mints a Ticket assigned to the caller", async () => {
    const [ticket] = await lottery.play.locally();
    expect(ticket.owner).toBe(ctx!.accounts[0]!.address);
  });

  it("play() onchain either increments num_winners to 1 or leaves it empty (ChaCha 50/50)", async () => {
    // settled() returns the confirmation status, so finalize aborts are
    // explicit rejected outcomes rather than ambiguous thrown errors.
    const confirmed = await lottery.play.settled({ confirmTimeout: 60_000 });
    const value = await lottery.mappings.numWinners.tryGet(0);

    if (confirmed.status === "accepted") {
      expect(value).toBe(1);
    } else {
      // ChaCha::rand_bool() → false aborted finalize before num_winners.set.
      expect(value).toBeNull();
    }
  });
});
