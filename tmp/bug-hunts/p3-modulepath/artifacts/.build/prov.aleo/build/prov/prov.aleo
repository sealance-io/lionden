program prov.aleo;

struct Env__DjN0EU5EAXY:
    account as address;
    count as u32;

function envelope_echo:
    input r0 as Env__DjN0EU5EAXY.private;
    output r0 as Env__DjN0EU5EAXY.private;

constructor:
    assert.eq edition 0u16;
