program registry.aleo;

struct TokenInfo:
    supply as u64;
    admin as address;

function echo:
    input r0 as TokenInfo.private;
    output r0 as TokenInfo.private;

constructor:
    assert.eq edition 0u16;
