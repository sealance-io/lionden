// Root of the multi-program spike package. Depends on both leaves, so a plain
// `leo deploy` here submits three deployments in dependency order and `--skip`
// can narrow it to one.
import spike_a.aleo;
import zspike_a.aleo;

program spike_main.aleo {
    @noupgrade
    constructor() {}

    fn drive(public slot: u32, public by: u32) -> Final {
        let a: Final = spike_a.aleo::bump(slot, by);
        let z: Final = zspike_a.aleo::accrue(slot, by);
        return final {
            a.run();
            z.run();
        };
    }
}
