program foo_bar.aleo;

struct Alpha:
    x as u32;

function echo_alpha:
    input r0 as Alpha.private;
    output r0 as Alpha.private;

constructor:
    assert.eq edition 0u16;
