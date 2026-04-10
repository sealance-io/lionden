program counter.aleo {
    @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
    constructor() {}

    mapping counters: address => u64;

    /// Increment the caller's counter by one.
    fn increment() -> Final {
        let sender: address = self.signer;
        return final {
            let current: u64 = counters.get_or_use(sender, 0u64);
            counters.set(sender, current + 1u64);
        };
    }
}
