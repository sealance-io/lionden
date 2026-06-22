program foo__bar.aleo;

struct Beta:
    y as u32;

function echo_beta:
    input r0 as Beta.private;
    output r0 as Beta.private;

constructor:
    assert.eq edition 0u16;
