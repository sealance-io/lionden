program counter.aleo {
    @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
    constructor() {}

    mapping counters: address => u64;

    /// New mapping added in v2 — ABI-compatible addition.
    mapping decrements: address => u64;

    /// Increment the caller's counter by one. Unchanged from v1.
    fn increment() -> Final {
        let sender: address = self.signer;
        return final {
            let current: u64 = counters.get_or_use(sender, 0u64);
            counters.set(sender, current + 1u64);
        };
    }

    /// Decrement counter — new transition added in v2.
    fn decrement() -> Final {
        let sender: address = self.signer;
        return final {
            let current: u64 = decrements.get_or_use(sender, 0u64);
            decrements.set(sender, current + 1u64);
        };
    }
}
