// v2 fixture used by the test to *attempt* an upgrade. Adds a new
// transition; the constructor remains @noupgrade so the network must
// reject this deployment with edition > 0.
program noupgrade_example.aleo {
    @noupgrade
    constructor() {}

    fn main(public a: u32, b: u32) -> u32 {
        let c: u32 = a + b;
        return c;
    }

    fn subtract(public a: u32, b: u32) -> u32 {
        let c: u32 = a - b;
        return c;
    }
}
