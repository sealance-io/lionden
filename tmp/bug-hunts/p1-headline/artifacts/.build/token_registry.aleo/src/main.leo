program token_registry.aleo {
    @noupgrade
    constructor() {}

    record Token {
        owner: address,
        amount: u64,
    }

    fn mint(amount: u64) -> Token {
        return Token { owner: self.signer, amount };
    }
}
