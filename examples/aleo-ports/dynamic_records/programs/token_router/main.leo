// token_router.aleo routes token operations to any TokenStandard-compliant
// program. It never knows the concrete record layout of GoldToken or
// SilverToken; all record I/O uses `dyn record`.
//
// Current Leo dynamic call syntax is:
//   TokenStandard@(token_program)::transfer(token, to)
//
// The upstream branch used the older `/transfer` spelling. This port
// normalizes to the v4 `::transfer` form used by local leo 4.0.x.
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

program token_router.aleo {
    fn route_transfer(
        token_program: identifier,
        token: dyn record,
        to: address,
    ) -> dyn record {
        let result: (dyn record, dyn record) = TokenStandard@(token_program)::transfer(token, to);
        return result.1;
    }

    fn read_balance(token_program: identifier, token: dyn record) -> u64 {
        return TokenStandard@(token_program)::balance_of(token);
    }

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

    fn gold_beats_silver(
        gold_tok: dyn record,
        silver_tok: dyn record,
    ) -> bool {
        let gold_bal: u64 = TokenStandard@('gold_token')::balance_of(gold_tok);
        let silver_bal: u64 = TokenStandard@('silver_token')::balance_of(silver_tok);
        return gold_bal > silver_bal;
    }

    fn has_more(
        prog_a: identifier,
        tok_a: dyn record,
        prog_b: identifier,
        tok_b: dyn record,
    ) -> bool {
        let bal_a: u64 = TokenStandard@(prog_a)::balance_of(tok_a);
        let bal_b: u64 = TokenStandard@(prog_b)::balance_of(tok_b);
        return bal_a > bal_b;
    }

    // Mints once and transfers twice, producing two `<token>.aleo/transfer`
    // transitions in the same callgraph. Used by the ambiguity test to
    // exercise `.from(name, idx, { match: 0 | 1 })` selection.
    fn demo_double_transfer(
        token_program: identifier,
        owner: address,
        amount: u64,
        to_a: address,
        to_b: address,
    ) -> dyn record {
        let t1: dyn record = TokenStandard@(token_program)::mint(owner, amount);
        let r1: (dyn record, dyn record) = TokenStandard@(token_program)::transfer(t1, to_a);
        let r2: (dyn record, dyn record) = TokenStandard@(token_program)::transfer(r1.1, to_b);
        return r2.1;
    }

    @noupgrade
    constructor() {}
}
