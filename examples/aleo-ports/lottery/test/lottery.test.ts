// Port of tmp/leo-examples/lottery/. Upstream run.sh just does `leo run play`
// once. The transition itself is deterministic (mints a Ticket); the
// finalize block coinflips via ChaCha::rand_bool() — so onchain calls
// abort ~50% of the time. The port asserts:
//   1. play() in local mode always returns a Ticket (finalize skipped).
//   2. play() onchain either succeeds (mapping num_winners[0u8] = "1u8")
//      or aborts (mapping stays empty / null). Both outcomes are valid.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

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
  it("play() in local mode mints a Ticket assigned to the caller", async () => {
    const result = await ctx!.execute("lottery.aleo", "play", [], { mode: "local" });
    const ticket = result.outputs[0]!;
    expect(ticket).toContain(ctx!.accounts[0]!.address);
    expect(ticket).toContain("owner:");
  });

  it("play() onchain either increments num_winners to 1u8 or leaves it empty (ChaCha 50/50)", async () => {
    let onchainSucceeded = false;
    try {
      await ctx!.execute("lottery.aleo", "play", []);
      onchainSucceeded = true;
    } catch {
      // ChaCha::rand_bool() returned false → finalize aborted. Expected ~50% of the time.
      onchainSucceeded = false;
    }

    const value = await ctx!.connection.getMappingValue(
      "lottery.aleo",
      "num_winners",
      "0u8",
    );

    if (onchainSucceeded) {
      expect(value).toBe("1u8");
    } else {
      // Finalize aborted before num_winners.set, so the mapping is unwritten.
      expect(value).toBeNull();
    }
  });
});
