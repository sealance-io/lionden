program legacy_context.aleo {
    @noupgrade
    constructor() {}

    /// Intentionally Leo 4.3-only: `self.signer` was removed in Leo 4.4.
    /// This fixture proves LionDen still compiles and runs legacy context
    /// metadata syntax when paired with a matching Leo 4.3 binary.
    fn get_signer() -> address {
        return self.signer;
    }
}
