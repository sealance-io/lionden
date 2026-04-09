import math_utils.aleo;
import treasury.aleo;

program rewards.aleo {
    @noupgrade
    constructor() {}

    /// Tracks reward points per address.
    mapping points: address => u64;

    /// Whether an address has claimed their reward.
    mapping claimed: address => bool;

    /// Earn reward points, capped at 500 per call.
    fn earn_points(public amount: u64) -> Final {
        let sender: address = self.signer;
        let capped: u64 = math_utils.aleo::min(amount, 500u64);
        return final {
            let current: u64 = points.get_or_use(sender, 0u64);
            points.set(sender, current + capped);
        };
    }

    /// Claim a reward once points reach the threshold.
    /// Grants a deposit in the treasury via cross-program call.
    fn claim_reward(public reward_amount: u64) -> Final {
        let sender: address = self.signer;
        // Cross-program call — treasury.deposit() returns Final
        let treasury_final: Final = treasury.aleo::deposit(reward_amount);
        return final {
            let current_points: u64 = points.get(sender);
            assert(current_points >= 100u64);

            let already_claimed: bool = claimed.get_or_use(sender, false);
            assert(!already_claimed);

            // Mark as claimed and execute the treasury deposit
            claimed.set(sender, true);
            treasury_final.run();
        };
    }
}
