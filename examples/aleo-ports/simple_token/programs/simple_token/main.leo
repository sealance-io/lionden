program simple_token.aleo {
    record Token {
        owner: address,
        amount: u64,
    }

    @noupgrade
    constructor() {}

    /// Mint a fresh Token record assigned to `owner`.
    fn mint(owner: address, amount: u64) -> Token {
        return Token { owner: owner, amount: amount };
    }

    /// Split `token` into a remainder for the sender and a transfer for `to`.
    /// `sub` is checked — the proof fails if `amount > token.amount`.
    fn transfer(token: Token, to: address, amount: u64) -> (Token, Token) {
        let difference: u64 = token.amount - amount;

        let remaining: Token = Token {
            owner: token.owner,
            amount: difference,
        };

        let transferred: Token = Token {
            owner: to,
            amount: amount,
        };

        return (remaining, transferred);
    }
}
