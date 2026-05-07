// @custom constructor implements a block-height timelock on upgrades.
// edition 0 (initial deploy) is unrestricted; subsequent editions can
// only land once block.height passes THRESHOLD.
//
// Upstream uses 1300; we use 30 to keep test runtime down —
// advanceBlocks() is one HTTP POST per block (~1s each).
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
}
