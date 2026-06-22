import foo_bar.aleo;
import foo__bar.aleo;
program consumer.aleo;

function relay:
    input r0 as foo_bar.aleo/Alpha.private;
    input r1 as foo__bar.aleo/Beta.private;
    output r0 as foo_bar.aleo/Alpha.private;
    output r1 as foo__bar.aleo/Beta.private;

constructor:
    assert.eq edition 0u16;
