// P7: transition names that collide with contract-class members.
//   connect    -> inherited BaseContract.connect(lre) method
//   withSigner -> inherited BaseContract.withSigner(signer) method
//   programId  -> inherited BaseContract.programId readonly property
//   mappings   -> the `readonly mappings` container (program also has a mapping)
// (`address` and `storage` are rejected by Leo as reserved, so they are
//  unreachable via real Leo and only latent at the codegen level.)
program member_collisions.aleo {
    @noupgrade
    constructor() {}

    mapping counts: address => u64;

    fn connect(a: u32) -> u32 {
        return a;
    }

    fn withSigner(a: u32) -> u32 {
        return a;
    }

    fn programId(a: u32) -> u32 {
        return a;
    }

    fn mappings(a: u32) -> u32 {
        return a;
    }

    fn bump(public who: address) -> Final {
        return final {
            let cur: u64 = counts.get_or_use(who, 0u64);
            counts.set(who, cur + 1u64);
        };
    }
}
