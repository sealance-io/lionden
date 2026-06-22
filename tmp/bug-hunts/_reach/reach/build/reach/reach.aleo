program reach.aleo;

function get:
    input r0 as u32.private;
    output r0 as u32.private;

constructor:
    assert.eq edition 0u16;
