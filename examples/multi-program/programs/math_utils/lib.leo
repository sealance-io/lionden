/// Shared math utilities used by treasury and rewards programs.
/// These are proof-context helpers (regular fn, outside program block).

/// Return the minimum of two values.
fn min(a: u64, b: u64) -> u64 {
    if a <= b {
        return a;
    }
    return b;
}

/// Return the maximum of two values.
fn max(a: u64, b: u64) -> u64 {
    if a >= b {
        return a;
    }
    return b;
}

/// Clamp a value between lower and upper bounds.
fn clamp(value: u64, lower: u64, upper: u64) -> u64 {
    if value < lower {
        return lower;
    }
    if value > upper {
        return upper;
    }
    return value;
}
