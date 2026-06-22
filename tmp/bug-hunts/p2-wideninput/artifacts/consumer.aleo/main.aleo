import registry.aleo;
program consumer.aleo;

struct WidenInput:
    n as u64;

function make:
    input r0 as u64.private;
    cast r0 into r1 as WidenInput;
    output r1 as WidenInput.private;

function relay:
    input r0 as registry.aleo/TokenInfo.private;
    output r0 as registry.aleo/TokenInfo.private;

constructor:
    assert.eq edition 0u16;
