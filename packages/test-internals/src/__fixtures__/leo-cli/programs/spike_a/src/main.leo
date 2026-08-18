// The @noupgrade leaf, final revision. Deliberately un-upgradeable: the
// on-chain constructor asserts `edition == 0`, so an upgrade to edition 1 is
// rejected at finalize time — the exit-0 case the spike exists to characterise.
//
// `reset` was added only to give the rejected upgrade something to change; the
// earlier deploy captures were taken with `bump` alone. See the revision table
// in ../../../README.md.
program spike_a.aleo {
    mapping counter: u32 => u32;

    @noupgrade
    constructor() {}

    fn bump(public slot: u32, public by: u32) -> Final {
        return final {
            let prev: u32 = counter.get_or_use(slot, 0u32);
            counter.set(slot, prev + by);
        };
    }

    fn reset(public slot: u32) -> Final {
        return final {
            counter.set(slot, 0u32);
        };
    }
}
