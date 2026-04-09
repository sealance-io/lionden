import math_utils.aleo;

program treasury.aleo {
    @noupgrade
    constructor() {}

    /// Tracks deposits per address.
    mapping deposits: address => u64;

    /// Deposit funds for the transaction signer, capped at 1_000_000 per call.
    /// Uses self.signer so deposits are keyed by the original signer
    /// even when called cross-program (e.g. from rewards.aleo).
    fn deposit(public amount: u64) -> Final {
        let who: address = self.signer;
        let capped: u64 = math_utils.aleo::min(amount, 1000000u64);
        return final {
            let current: u64 = deposits.get_or_use(who, 0u64);
            deposits.set(who, current + capped);
        };
    }

    /// Withdraw funds for the transaction signer.
    fn withdraw(public amount: u64) -> Final {
        let who: address = self.signer;
        return final {
            let current: u64 = deposits.get(who);
            assert(current >= amount);
            deposits.set(who, current - amount);
        };
    }
}
