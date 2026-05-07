// Port of tmp/leo-examples/auction/. Three actors (bidder1, bidder2,
// auctioneer) chained through Bid records. The auctioneer address is
// hard-coded in the program to `aleo1ashyu96…` which matches devnode
// account-2.
//
// All transitions are pure (no Final, no mappings) — `mode: "local"`
// suffices for the whole flow, and outputs[0] is a plaintext Bid record
// that can be read directly and chained.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

async function deployAuction() {
  const ctx = await setup();
  try {
    await ctx.deploy("auction", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployAuction);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

/// Extract `<field>: <value>` from a Bid record literal. Strips the
/// trailing `.private` / `.public` visibility marker from the captured
/// value so callers can compare against bare literals.
function extract(record: string, field: string): string {
  const match = record.match(new RegExp(`${field}:\\s*([^,}\\s]+)`));
  if (!match) throw new Error(`could not extract ${field} from: ${record}`);
  return match[1]!.replace(/\.(private|public)$/, "");
}

describe("auction.aleo", () => {
  const bidder1 = () => ctx!.accounts[0]!;
  const bidder2 = () => ctx!.accounts[1]!;
  const auctioneer = () => ctx!.accounts[2]!;

  // Captured during the bidding tests for downstream resolve/finish.
  let bid1: string | undefined;
  let bid2: string | undefined;

  it("place_bid() requires caller to match bidder", async () => {
    await expect(
      ctx!.execute(
        "auction.aleo",
        "place_bid",
        [bidder1().address, "10u64"],
        { mode: "local", signer: bidder2() },
      ),
    ).rejects.toThrow();
  });

  it("bidder1 places a bid of 10", async () => {
    const result = await ctx!.execute(
      "auction.aleo",
      "place_bid",
      [bidder1().address, "10u64"],
      { mode: "local", signer: bidder1() },
    );
    bid1 = result.outputs[0]!;
    expect(extract(bid1, "amount")).toBe("10u64");
    expect(extract(bid1, "is_winner")).toBe("false");
    expect(bid1).toContain(bidder1().address);
  });

  it("bidder2 places a bid of 90", async () => {
    const result = await ctx!.execute(
      "auction.aleo",
      "place_bid",
      [bidder2().address, "90u64"],
      { mode: "local", signer: bidder2() },
    );
    bid2 = result.outputs[0]!;
    expect(extract(bid2, "amount")).toBe("90u64");
    expect(bid2).toContain(bidder2().address);
  });

  it("resolve() rejects callers that aren't the auctioneer", async () => {
    expect(bid1, "place_bid 1 must run first").toBeDefined();
    expect(bid2, "place_bid 2 must run first").toBeDefined();
    await expect(
      ctx!.execute(
        "auction.aleo",
        "resolve",
        [bid1!, bid2!],
        { mode: "local", signer: bidder1() },
      ),
    ).rejects.toThrow();
  });

  it("auctioneer.resolve() picks the higher bid", async () => {
    const result = await ctx!.execute(
      "auction.aleo",
      "resolve",
      [bid1!, bid2!],
      { mode: "local", signer: auctioneer() },
    );
    const winner = result.outputs[0]!;
    expect(extract(winner, "amount")).toBe("90u64");
    expect(winner).toContain(bidder2().address);
  });

  it("auctioneer.finish() flips is_winner=true and re-owns the Bid to the bidder", async () => {
    // Re-resolve to get a fresh winner Bid (resolve in this run hasn't been
    // chained yet because the prior resolve was scoped to its own assertion).
    const resolved = await ctx!.execute(
      "auction.aleo",
      "resolve",
      [bid1!, bid2!],
      { mode: "local", signer: auctioneer() },
    );
    const winnerBid = resolved.outputs[0]!;

    const finished = await ctx!.execute(
      "auction.aleo",
      "finish",
      [winnerBid],
      { mode: "local", signer: auctioneer() },
    );
    const finishedBid = finished.outputs[0]!;
    expect(extract(finishedBid, "is_winner")).toBe("true");
    // Owner is now the bidder, not the auctioneer.
    expect(extract(finishedBid, "owner")).toBe(`${bidder2().address}`);
  });
});
