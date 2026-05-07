program twoadicity.aleo {
    @noupgrade
    constructor() {}

    /// Counts the number of factors of 2 in `n` (twoadicity), capped at 252.
    fn main(public n: field) -> u8 {
        let remaining_n: field = n;
        let powers_of_two: u8 = 0u8;
        for i: u8 in 0u8..252u8 {
            if is_even_and_nonzero(remaining_n) {
                remaining_n = remaining_n / 2field;
                powers_of_two = powers_of_two + 1u8;
            }
        }
        return powers_of_two;
    }
}

/// is_even_and_nonzero on field elements:
/// for an even, nonzero n, n/2 < n. For odd n, the field-equivalent halving
/// produces a value greater than n. So `n/2 < n` is true exactly for even,
/// nonzero `n`.
fn is_even_and_nonzero(n: field) -> bool {
    return n / 2field < n;
}
