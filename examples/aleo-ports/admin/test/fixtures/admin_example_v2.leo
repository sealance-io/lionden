// v2 fixture: adds a `subtract` transition. Constructor unchanged so the
// admin can authorize the upgrade. (`sub` is a reserved opcode name in
// Leo, so we use `subtract`.)
program admin_example.aleo {
    @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
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
