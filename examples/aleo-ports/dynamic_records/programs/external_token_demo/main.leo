// external_token_demo.aleo: canonical demonstration of external Record outputs
// and dyn-record passthrough flows. Imports gold/silver tokens and dispatches
// via the TokenStandard interface.
//
// - `wrap_mint_gold` returns an imported `gold_token.aleo::Token` directly,
//   surfacing the external-record id-only output shape on the caller and the
//   recoverable ciphertext on the callee transition.
// - `issue_receipt` accepts a `dyn record` input and emits a concrete local
//   `Receipt` record (decryptable via the standard `EncryptedRecord<T>` path).
// - `dispatch_and_receipt` calls the token interface's `transfer` (which
//   returns `(Token, dyn record)` under V15-compliant materialization) and
//   then `balance_of` against the dynamic handle before emitting a Receipt.
//
// Under snarkVM ConsensusVersion::V15 (`ensure_records_exist`), the token
// programs' `transfer` must materialize the static record alongside the
// dynamic handle. See docs/research/snarkvm-record-existence.md for the rule.

import gold_token.aleo;
import silver_token.aleo;

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

program external_token_demo.aleo {
    record Receipt {
        owner: address,
        balance: u64,
    }

    // External record output: direct return of an imported program's Token.
    // Caller-side output is id-only (`external_record`); ciphertext lives on
    // the callee `gold_token.mint` transition.
    fn wrap_mint_gold(to: address, amount: u64) -> gold_token.aleo::Token {
        return gold_token.aleo::mint(to, amount);
    }

    // Dyn record input, concrete local record output. Receipt carries a
    // ciphertext (ordinary record).
    fn issue_receipt(
        token_program: identifier,
        token: dyn record,
        to: address,
    ) -> Receipt {
        let balance: u64 = TokenStandard@(token_program)::balance_of(token);
        return Receipt { owner: to, balance };
    }

    // Nested call graph: dispatch produces a `(Token, dyn record)` tuple,
    // we forward the dynamic member to `balance_of`, and emit a concrete
    // final Receipt. Intermediate dyn-record dispatch doesn't poison the
    // concrete output, and the callee's materialized Token is recoverable
    // from `confirmed.transitions` via decryptFrom.
    fn dispatch_and_receipt(
        token_program: identifier,
        token: dyn record,
        to: address,
    ) -> Receipt {
        let result: (dyn record, dyn record) = TokenStandard@(token_program)::transfer(token, to);
        let balance: u64 = TokenStandard@(token_program)::balance_of(result.1);
        return Receipt { owner: to, balance };
    }

    @noupgrade
    constructor() {}
}
