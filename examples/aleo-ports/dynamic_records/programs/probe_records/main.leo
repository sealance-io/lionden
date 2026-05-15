// Probe program for Phase A2 — empirical record-output shape verification.
// Imports gold/silver tokens and dispatches via the TokenStandard interface
// to exercise dyn-record passthrough flows with concrete final outputs, plus
// external-record direct returns.

import gold_token.aleo;
import silver_token.aleo;

interface TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        ..
    }
    fn mint(owner: address, amount: u64) -> Token;
    fn transfer(token: dyn record, to: address) -> dyn record;
    fn balance_of(token: dyn record) -> u64;
}

program probe_records.aleo {
    record Receipt {
        owner: address,
        balance: u64,
    }

    // X1: external record output (direct return of imported type).
    // Hypothesis: chain may surface this with a ciphertext (works like local).
    fn wrap_mint_gold(to: address, amount: u64) -> gold_token.aleo::Token {
        return gold_token.aleo::mint(to, amount);
    }

    // X2: dyn record input, concrete local record output.
    // Hypothesis: Receipt carries a ciphertext (ordinary record).
    fn issue_receipt(
        token_program: identifier,
        token: dyn record,
        to: address,
    ) -> Receipt {
        let balance: u64 = TokenStandard@(token_program)::balance_of(token);
        return Receipt { owner: to, balance };
    }

    // X3: nested call graph — dispatch produces dyn record intermediate,
    //     we consume it and emit a concrete final record.
    // Hypothesis: intermediate dyn records don't poison the concrete output.
    fn dispatch_and_receipt(
        token_program: identifier,
        token: dyn record,
        to: address,
    ) -> Receipt {
        let transferred: dyn record = TokenStandard@(token_program)::transfer(token, to);
        let balance: u64 = TokenStandard@(token_program)::balance_of(transferred);
        return Receipt { owner: to, balance };
    }

    @noupgrade
    constructor() {}
}
