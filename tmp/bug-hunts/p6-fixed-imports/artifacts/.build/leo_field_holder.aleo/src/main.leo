// P6a: local struct named `LeoField` collides with the fixed `type LeoField`
// import that baseContractImport() always emits.
program leo_field_holder.aleo {
    @noupgrade
    constructor() {}

    struct LeoField {
        x: u32,
    }

    fn use_it(a: LeoField) -> u32 {
        return a.x;
    }
}
