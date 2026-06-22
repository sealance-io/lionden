// P4: `foo__bar.aleo` (consecutive underscore, accepted by Leo) -> "FooBar" too.
// Both programs write typechain/FooBar.ts; the second overwrites the first.
program foo__bar.aleo {
    @noupgrade
    constructor() {}

    struct Beta {
        y: u32,
    }

    fn echo_beta(b: Beta) -> Beta {
        return b;
    }
}
