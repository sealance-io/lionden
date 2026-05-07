program lottery.aleo {
    @noupgrade
    constructor() {}

    /// Counts the number of winners observed (capped at 5 by finalize).
    mapping num_winners: u8 => u8;

    record Ticket {
        owner: address,
    }

    /// Mint a Ticket; finalize coinflips whether it counts as a winning ticket.
    /// Finalize asserts:
    ///   - block.height <= 1000  (lottery hasn't expired)
    ///   - ChaCha::rand_bool() == true  (50/50 — half of all plays abort here)
    ///   - num_winners[0u8] < 5  (cap)
    fn play() -> (Ticket, Final) {
        let ticket: Ticket = Ticket {
            owner: self.caller,
        };
        return (ticket, final {
            assert(block.height <= 1000u32);
            assert(ChaCha::rand_bool());
            let winners: u8 = num_winners.get_or_use(0u8, 0u8);
            assert(winners < 5u8);
            num_winners.set(0u8, winners + 1u8);
        });
    }
}
