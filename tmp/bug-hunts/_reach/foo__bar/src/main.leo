// The 'foo__bar' program.
program foo__bar.aleo {
    // This is the constructor for the program.
    // The constructor allows you to manage program upgrades.
    // It is called when the program is deployed or upgraded.
    // It is currently configured to **prevent** upgrades.
    // Other configurations include:
    //  - @admin(address="aleo1...")
    //  - @checksum(mapping="credits.aleo/fixme", key="0field")
    //  - @custom
    // For more information, please refer to the documentation: `https://docs.leo-lang.org/guides/upgradability`
    @noupgrade
    constructor() {}

    fn main(public a: u32, b: u32) -> u32 {
        let c: u32 = a + b;
        return c;
    }
}
