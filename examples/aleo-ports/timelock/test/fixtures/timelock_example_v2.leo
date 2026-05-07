// v2 fixture: adds a `subtract` transition. Constructor body is
// unchanged, so the same block-height check governs the upgrade.
program timelock_example.aleo {
    @custom
    constructor() {
        if self.edition > 0u16 {
            assert(block.height >= 30u32);
        }
    }

    fn main(public a: u32, b: u32) -> u32 {
        let c: u32 = a + b;
        return c;
    }

    fn subtract(public a: u32, b: u32) -> u32 {
        let c: u32 = a - b;
        return c;
    }
}
