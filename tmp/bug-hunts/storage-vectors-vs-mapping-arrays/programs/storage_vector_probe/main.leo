program storage_vector_probe.aleo {
    storage admin: address;
    storage field_history: [field];

    mapping fixed_rows: bool => [u8; 3];

    fn seed(public owner: address, public first: field, public second: field) -> Final {
        return final {
            admin = owner;
            field_history.clear();
            field_history.push(first);
            field_history.push(second);
            Mapping::set(fixed_rows, true, [1u8, 2u8, 3u8]);
        };
    }

    fn assert_vector_slot(public index: u32, public expected: field) -> Final {
        return final {
            let actual: field = field_history.get(index).unwrap();
            assert(actual == expected);
        };
    }

    @noupgrade
    constructor() {}
}
