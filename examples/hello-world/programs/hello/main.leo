program hello.aleo {
    @noupgrade
    fn constructor() {}

    /// Add two unsigned 32-bit integers.
    fn main(a: u32, b: u32) -> u32 {
        return a + b;
    }

    /// Multiply two unsigned 32-bit integers.
    fn multiply(a: u32, b: u32) -> u32 {
        return a * b;
    }
}
