import prov.aleo;
program consumer.aleo;

struct Prov_Sh_Env:
    tag as u32;

function local_make:
    input r0 as u32.private;
    cast r0 into r1 as Prov_Sh_Env;
    output r1 as Prov_Sh_Env.private;

function relay:
    input r0 as prov.aleo/Env__DjN0EU5EAXY.private;
    output r0 as prov.aleo/Env__DjN0EU5EAXY.private;

constructor:
    assert.eq edition 0u16;
