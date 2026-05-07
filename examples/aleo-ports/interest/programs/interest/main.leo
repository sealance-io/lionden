program interest.aleo {
    @noupgrade
    constructor() {}

    /// Accrues interest over exactly 10 iterations.
    fn fixed_iteration_interest(capital: u32, public rate: u32) -> u32 {
        let amount: u32 = capital;

        for i: u8 in 0u8..10u8 {
            amount += (amount * rate) / 100u32;
        }
        return amount;
    }

    /// Accrues interest over up to 50 iterations (capped at 40 by an early return).
    fn bounded_iteration_interest(capital: u32, public rate: u32, iterations: u8) -> u32 {
        assert(iterations <= 50u8);
        let amount: u32 = capital;

        for i: u8 in 0u8..50u8 {
            if i < iterations {
                amount += (amount * rate) / 100u32;
            }
            if i == 40u8 {
                return amount;
            }
        }
        return amount;
    }
}
