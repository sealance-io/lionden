// Second leaf. The name is deliberately chosen so that the *full* program id of
// `spike_a.aleo` is a strict substring of `zspike_a.aleo`, which is what makes
// the `--skip` collision question (spike question 3) answerable.
program zspike_a.aleo {
    mapping total: u32 => u32;

    @noupgrade
    constructor() {}

    fn accrue(public slot: u32, public by: u32) -> Final {
        return final {
            let prev: u32 = total.get_or_use(slot, 0u32);
            total.set(slot, prev + by);
        };
    }
}
