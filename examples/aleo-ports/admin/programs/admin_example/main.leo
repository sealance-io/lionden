// v1 baseline (edition 0): @admin(address=...) restricts who may deploy or
// upgrade this program. Only `main` exists here; the v2 fixture adds a
// `subtract` transition, so the admin-authorized upgrade is a real ABI change.
//
// Leo constructor/upgrade compatibility smoke — lionden does no upgrade
// validation; Leo and the network own correctness.
program admin_example.aleo {
    @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
    constructor() {}

    fn main(public a: u32, b: u32) -> u32 {
        let c: u32 = a + b;
        return c;
    }
}
