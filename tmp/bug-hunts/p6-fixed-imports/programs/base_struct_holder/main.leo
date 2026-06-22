// P6b: local struct named `BaseContract` collides with the fixed `BaseContract`
// value/class import.
program base_struct_holder.aleo {
    @noupgrade
    constructor() {}

    struct BaseContract {
        x: u32,
    }

    fn use_it(a: BaseContract) -> u32 {
        return a.x;
    }
}
