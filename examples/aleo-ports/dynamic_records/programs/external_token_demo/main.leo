// external_token_demo.aleo: canonical demonstration of external Record outputs
// and dyn-record passthrough flows. Imports gold/silver tokens and dispatches
// via the TokenStandard interface.
//
// - `wrap_mint_gold` returns an imported `gold_token.aleo::Token` directly,
//   surfacing the external-record id-only output shape on the caller and the
//   recoverable ciphertext on the callee transition.
// - `issue_receipt` mints a token internally, reads its balance via the
//   interface's pure-read `balance_of`, and emits a concrete local `Receipt`
//   record (decryptable via the standard `EncryptedRecord<T>` path).
// - `dispatch_and_receipt` accepts a root `dyn record`, calls the token
//   interface's `transfer` to materialize it (a real spend), then reads the
//   transferred handle's balance field before emitting a Receipt.
//
// Under snarkVM ConsensusVersion::V15 (`ensure_records_exist`), a non-static
// root input must be consumed as a static record within the same execution.
// `transfer` does this (concrete `Token` input); `balance_of` is a pure read,
// so it is only ever applied to a dynamic record produced inside the execution
// (a mint or transfer output), never to a root input.

import gold_token.aleo;
import silver_token.aleo;

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

    // Mints a token internally, reads it with the pure-read `balance_of`, and
    // emits a concrete local Receipt (ordinary record carrying a ciphertext).
    // The minted dynamic record is produced inside this execution, so it is
    // not a root input and needs no static materialization under V15.
    fn issue_receipt(
        token_program: identifier,
        owner: address,
        amount: u64,
        to: address,
    ) -> Receipt {
        let token: dyn record = TokenStandard@(token_program)::mint(owner, amount);
        let balance: u64 = TokenStandard@(token_program)::balance_of(token);
        return Receipt { owner: to, balance };
    }

    // Nested call graph: dispatch produces a `(Token, dyn record)` tuple,
    // materializing the root dynamic input, then the dynamic member's balance
    // field is read directly before emitting a concrete final Receipt. The
    // callee's materialized Token is recoverable from `confirmed.transitions`
    // via the matcher API
    // (`.match(matcher.from(...)|.at(...)).decrypt(key)`).
    fn dispatch_and_receipt(
        token_program: identifier,
        token: dyn record,
        to: address,
    ) -> Receipt {
        let result: (dyn record, dyn record) = TokenStandard@(token_program)::transfer(token, to);
        let balance: u64 = result.1.amount;
        return Receipt { owner: to, balance };
    }

    @noupgrade
    constructor() {}
}
