// Port of tmp/leo-examples/auction/. Three actors (bidder1, bidder2,
// auctioneer) chained through Bid records. The auctioneer address is
// hard-coded in the program to `aleo1ashyu96…` which matches devnode
// account-2.
//
// All transitions are pure (no Final, no mappings) — `mode: "local"`
// suffices for the whole flow, and the typed wrapper deserializes the Bid
// record output so callers can chain it back into the next transition.

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Bid, createAuction } from "../typechain/Auction.js";

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

describe("auction.aleo", () => {
  const auction = createAuction();
  const bidder1 = () => ctx!.accounts[0]!;
  const bidder2 = () => ctx!.accounts[1]!;
  const auctioneer = () => ctx!.accounts[2]!;

  beforeAll(() => {
    auction.connect(ctx!.lre);
  });

  // Captured during the bidding tests for downstream resolve/finish.
  let bid1: Bid | undefined;
  let bid2: Bid | undefined;

  it("place_bid() requires caller to match bidder", async () => {
    await auction.withSigner(bidder2()).place_bid.failsLocally(bidder1(), 10n);
  });

  it("bidder1 places a bid of 10", async () => {
    bid1 = await auction.withSigner(bidder1()).place_bid.locally(bidder1(), 10n);
    expect(bid1.amount).toBe(10n);
    expect(bid1.is_winner).toBe(false);
    expect(bid1.bidder).toBe(bidder1().address);
  });

  it("bidder2 places a bid of 90", async () => {
    bid2 = await auction.withSigner(bidder2()).place_bid.locally(bidder2(), 90n);
    expect(bid2.amount).toBe(90n);
    expect(bid2.bidder).toBe(bidder2().address);
  });

  it("resolve() rejects callers that aren't the auctioneer", async () => {
    expect(bid1, "place_bid 1 must run first").toBeDefined();
    expect(bid2, "place_bid 2 must run first").toBeDefined();
    await auction.withSigner(bidder1()).resolve.failsLocally(bid1!, bid2!);
  });

  it("auctioneer.resolve() picks the higher bid", async () => {
    const winner = await auction.withSigner(auctioneer()).resolve.locally(bid1!, bid2!);
    expect(winner.amount).toBe(90n);
    expect(winner.bidder).toBe(bidder2().address);
  });

  it("auctioneer.finish() flips is_winner=true and re-owns the Bid to the bidder", async () => {
    // Re-resolve to get a fresh winner Bid (resolve in this run hasn't been
    // chained yet because the prior resolve was scoped to its own assertion).
    const auctioneerBound = auction.withSigner(auctioneer());
    const winnerBid = await auctioneerBound.resolve.locally(bid1!, bid2!);
    const finishedBid = await auctioneerBound.finish.locally(winnerBid);
    expect(finishedBid.is_winner).toBe(true);
    // Owner is now the bidder, not the auctioneer.
    expect(finishedBid.owner).toBe(bidder2().address);
  });
});
