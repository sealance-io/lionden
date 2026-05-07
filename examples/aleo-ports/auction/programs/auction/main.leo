program auction.aleo {
    @noupgrade
    constructor() {}

    record Bid {
        owner: address,
        bidder: address,
        amount: u64,
        is_winner: bool,
    }

    /// Place a bid. Caller must equal `bidder`. Returned record is owned by
    /// the hardcoded auctioneer (devnode account-2).
    fn place_bid(bidder: address, amount: u64) -> Bid {
        assert_eq(self.caller, bidder);
        return Bid {
            owner: aleo1ashyu96tjwe63u0gtnnv8z5lhapdu4l5pjsl2kha7fv7hvz2eqxs5dz0rg,
            bidder: bidder,
            amount: amount,
            is_winner: false,
        };
    }

    /// Auctioneer-only. Returns the higher of two bids; first wins on ties.
    fn resolve(first: Bid, second: Bid) -> Bid {
        assert_eq(self.caller, aleo1ashyu96tjwe63u0gtnnv8z5lhapdu4l5pjsl2kha7fv7hvz2eqxs5dz0rg);
        if (first.amount >= second.amount) {
            return first;
        } else {
            return second;
        }
    }

    /// Auctioneer-only. Marks the bid as winning and transfers ownership
    /// back to the bidder.
    fn finish(bid: Bid) -> Bid {
        assert_eq(self.caller, aleo1ashyu96tjwe63u0gtnnv8z5lhapdu4l5pjsl2kha7fv7hvz2eqxs5dz0rg);
        return Bid {
            owner: bid.bidder,
            bidder: bid.bidder,
            amount: bid.amount,
            is_winner: true,
        };
    }
}
