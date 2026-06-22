// P4: `foo_bar.aleo` -> programIdToClassName -> "FooBar" -> typechain/FooBar.ts
program foo_bar.aleo {
    @noupgrade
    constructor() {}

    struct Alpha {
        x: u32,
    }

    fn echo_alpha(a: Alpha) -> Alpha {
        return a;
    }
}
