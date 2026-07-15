// Source program deployed at runtime as tenant_gold.aleo. The source identity
// stays gold_token.aleo so upgrades can recompile through recorded provenance.
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

program gold_token.aleo : TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        purity: u64,
    }

    @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
    constructor() {}

    fn mint(owner: address, amount: u64) -> Token {
        return Token { owner, amount, purity: 24u64 };
    }

    fn mint_custom(owner: address, amount: u64, purity: u64) -> Token {
        assert(purity >= 1u64 && purity <= 24u64);
        return Token { owner, amount, purity };
    }

    fn transfer(token: Token, to: address) -> (Token, dyn record) {
        let amount: u64 = token.amount;
        let purity: u64 = token.purity;
        let new_token: Token = Token { owner: to, amount, purity };
        return (new_token, new_token as dyn record);
    }

    fn balance_of(token: dyn record) -> u64 {
        return token.amount;
    }
}
