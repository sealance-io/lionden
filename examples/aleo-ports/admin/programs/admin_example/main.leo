// @admin restricts deploy/upgrade to a fixed address. Devnode account-0
// is the admin here; namedAccounts wires it through in lionden.config.ts.
program admin_example.aleo {
    @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
    constructor() {}

    fn main(public a: u32, b: u32) -> u32 {
        let c: u32 = a + b;
        return c;
    }
}
