import gold_token.aleo;
program consumer.aleo;

record Receipt:
    owner as address.private;
    amount as u64.private;

function issue:
    input r0 as u64.private;
    cast self.signer r0 into r1 as Receipt.record;
    output r1 as Receipt.record;

function forward:
    input r0 as gold_token.aleo/Token.record;
    output r0 as gold_token.aleo/Token.record;

constructor:
    assert.eq edition 0u16;
