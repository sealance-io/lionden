// P2: consumer declares a LOCAL struct literally named `WidenInput`, which would
// clash with the `type WidenInput` import the external input alias needs (TS2440)
// unless the import is aliased to `WidenInput_`.
import registry.aleo;

program consumer.aleo {
    @noupgrade
    constructor() {}

    struct WidenInput {
        n: u64,
    }

    fn make(n: u64) -> WidenInput {
        return WidenInput { n };
    }

    fn relay(info: registry.aleo::TokenInfo) -> registry.aleo::TokenInfo {
        return info;
    }
}
