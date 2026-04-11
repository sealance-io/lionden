program escrow.aleo {
    @noupgrade
    constructor() {}

    /// Escrow lifecycle: 0 = created, 1 = funded, 2 = completed.
    mapping escrow_status: u64 => u8;

    /// Create a new escrow for the given item.
    fn create_escrow(public item_id: u64) -> Final {
        assert(item_id > 0u64);
        return final {
            escrow_status.set(item_id, 0u8);
        };
    }

    /// Fund the escrow — transitions status from created to funded.
    fn fund_escrow(public item_id: u64) -> Final {
        return final {
            let status: u8 = escrow_status.get(item_id);
            assert_eq(status, 0u8);
            escrow_status.set(item_id, 1u8);
        };
    }

    /// Mark the escrow as completed.
    fn complete_escrow(public item_id: u64) -> Final {
        return final {
            let status: u8 = escrow_status.get(item_id);
            assert_eq(status, 1u8);
            escrow_status.set(item_id, 2u8);
        };
    }
}
