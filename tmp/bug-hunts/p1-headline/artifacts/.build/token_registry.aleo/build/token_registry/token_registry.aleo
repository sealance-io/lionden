program token_registry.aleo;

record Token:
    owner as address.private;
    amount as u64.private;

function mint:
    input r0 as u64.private;
    cast self.signer r0 into r1 as Token.record;
    output r1 as Token.record;

constructor:
    assert.eq edition 0u16;
