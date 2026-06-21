program dynamic_mapping_vector.aleo {
    mapping dynamic_rows: bool => [field];

    fn write(public first: field, public second: field) -> Final {
        return final {
            Mapping::set(dynamic_rows, true, [first, second]);
        };
    }

    @noupgrade
    constructor() {}
}
