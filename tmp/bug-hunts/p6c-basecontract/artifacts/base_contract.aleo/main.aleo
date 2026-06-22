program base_contract.aleo;

function identity:
    input r0 as u32.private;
    output r0 as u32.private;

constructor:
    assert.eq edition 0u16;
