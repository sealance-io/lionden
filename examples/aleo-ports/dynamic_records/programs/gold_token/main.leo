// gold_token.aleo: private gold token implementing the TokenStandard interface.
//
// The Token record carries an extra `purity` field beyond the interface
// minimum. When called through dynamic dispatch, callers receive it as a
// `dyn record` and do not need to know about `purity` at compile time.
//
// `transfer` returns `(Token, dyn record)` to satisfy snarkVM V15's
// `ensure_records_exist` rule: the locally-minted static Token is output
// alongside the dynamic handle. See docs/research/snarkvm-record-existence.md.
interface TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        ..
    }
    fn mint(owner: address, amount: u64) -> Token;
    fn transfer(token: dyn record, to: address) -> (Token, dyn record);
    fn balance_of(token: dyn record) -> u64;
}

program gold_token.aleo : TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        purity: u64,
    }

    fn mint(owner: address, amount: u64) -> Token {
        return Token { owner, amount, purity: 24u64 };
    }

    fn mint_custom(owner: address, amount: u64, purity: u64) -> Token {
        assert(purity >= 1u64 && purity <= 24u64);
        return Token { owner, amount, purity };
    }

    fn transfer(token: dyn record, to: address) -> (Token, dyn record) {
        let amount: u64 = token.amount;
        let purity: u64 = token.purity;
        let new_token: Token = Token { owner: to, amount, purity };
        return (new_token, new_token as dyn record);
    }

    fn balance_of(token: dyn record) -> u64 {
        return token.amount;
    }

    @noupgrade
    constructor() {}
}
