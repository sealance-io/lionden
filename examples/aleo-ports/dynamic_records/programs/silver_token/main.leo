// silver_token.aleo: private silver token implementing TokenStandard.
//
// Its Token record adds a `grade` field instead of gold_token's `purity`.
// Both record shapes satisfy the same interface and can be routed uniformly.
//
// `transfer` consumes a concrete Token so a root dynamic input passed through
// the interface is materialized under the V15 record-existence rule, and also
// emits a dynamic handle for routers. `balance_of` is a pure read of a
// `dyn record`: under V15 it cannot be a root transition on a held token (a
// non-static root input must be consumed as a static record in the same
// execution), so callers read it on a dynamic record produced inside the
// execution (e.g. a mint or transfer output).
interface TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        ..
    }
    fn mint(owner: address, amount: u64) -> Token;
    fn transfer(token: Token, to: address) -> (Token, dyn record);
    fn balance_of(token: dyn record) -> u64;
}

program silver_token.aleo : TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        grade: u64,
    }

    fn mint(owner: address, amount: u64) -> Token {
        return Token { owner, amount, grade: 3u64 };
    }

    fn mint_custom(owner: address, amount: u64, grade: u64) -> Token {
        assert(grade <= 3u64);
        return Token { owner, amount, grade };
    }

    fn transfer(token: Token, to: address) -> (Token, dyn record) {
        let amount: u64 = token.amount;
        let grade: u64 = token.grade;
        let new_token: Token = Token { owner: to, amount, grade };
        return (new_token, new_token as dyn record);
    }

    fn balance_of(token: dyn record) -> u64 {
        return token.amount;
    }

    @noupgrade
    constructor() {}
}
