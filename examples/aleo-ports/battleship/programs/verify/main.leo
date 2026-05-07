/// Population count of the lower 64 bits via the SWAR trick.
fn bitcount(bits: u64) -> u64 {
    let r1: u64 = bits / 2u64;
    let r2: u64 = bits / 4u64;
    let r3: u64 = bits / 8u64;

    let r4: u64 = r1 & 8608480567731124087u64;
    let r5: u64 = r2 & 3689348814741910323u64;
    let r6: u64 = r3 & 1229782938247303441u64;

    let r7: u64 = bits - r4 - r5 - r6;

    let r8: u64 = r7 / 16u64;
    let r9: u64 = r7 + r8;
    let r10: u64 = r9 & 1085102592571150095u64;
    return r10 % 255u64;
}

/// True when `ship`'s flipped bits are adjacent under the given orientation.
fn adjacency_check(ship: u64, orientation: u64) -> bool {
    let division: u64 = ship / orientation;
    let is_eq: bool = division == 0u64;
    let ternary: u64 = is_eq ? 3u64 : division;
    let subtraction: u64 = ternary - 1u64;
    let and: u64 = subtraction & ternary;
    return and == 0u64;
}

/// Horizontal placement must not split across an 8-bit row boundary.
fn horizontal_check(ship: u64, horizontal: u64) -> bool {
    let remainder: u64 = ship % 255u64;
    let division: u64 = remainder / horizontal;
    let is_eq: bool = division == 0u64;
    let ternary: u64 = is_eq ? 3u64 : division;
    let subtraction: u64 = ternary - 1u64;
    let and: u64 = subtraction & ternary;
    return and == 0u64;
}

program verify.aleo {
    @noupgrade
    constructor() {}

    /// True when `ship` has exactly `length` flipped bits placed horizontally
    /// or vertically without crossing 8-bit row boundaries.
    fn validate_ship(ship: u64, length: u64, horizontal: u64, vertical: u64) -> bool {
        let num_bits: u64 = bitcount(ship);
        assert_eq(num_bits, length);

        let is_adjacent: bool = adjacency_check(ship, horizontal);
        let is_horizontal: bool = horizontal_check(ship, horizontal);
        let valid_horizontal: bool = is_adjacent && is_horizontal;

        let valid_vertical: bool = adjacency_check(ship, vertical);

        return valid_horizontal || valid_vertical;
    }

    /// Combine four ship bitstrings into a single board. Asserts no overlaps
    /// (popcount of the OR must equal 5+4+3+2 = 14).
    fn create_board(carrier: u64, battleship: u64, cruiser: u64, destroyer: u64) -> u64 {
        let ships: u64 = carrier | battleship | cruiser | destroyer;
        let num_bits: u64 = bitcount(ships);
        assert_eq(num_bits, 14u64);
        return ships;
    }
}
