// Minimal router for exercising dynamic dispatch into a renamed token program.
interface TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        ..
    }
    fn mint(owner: address, amount: u64) -> Token;
    fn transfer(token: Token, to: address) -> (Token, dyn record);
}

program token_router.aleo {
    fn demo_transfer(
        token_program: identifier,
        owner: address,
        amount: u64,
        to: address,
    ) -> dyn record {
        let token: dyn record = TokenStandard@(token_program)::mint(owner, amount);
        let result: (dyn record, dyn record) = TokenStandard@(token_program)::transfer(token, to);
        return result.1;
    }

    @noupgrade
    constructor() {}
}
