// P6c: program id `base_contract.aleo` -> class BaseContract -> the per-program
// emit loop writes typechain/BaseContract.ts, OVERWRITING the runtime
// BaseContract.ts emitted just before it.
program base_contract.aleo {
    @noupgrade
    constructor() {}

    fn identity(a: u32) -> u32 {
        return a;
    }
}
