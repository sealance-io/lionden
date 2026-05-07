program groups.aleo {
    @noupgrade
    constructor() {}

    /// 2a + (-2a) + GEN = GEN — exercises double, neg, scalar mul, add.
    fn main(a: group) -> group {
        let b: group = a.double();
        let c: group = b.neg();

        let d: group = (a * 2scalar).add(c);

        let e: group = group::GEN;

        return d + e;
    }
}
