program base_struct_holder.aleo;

struct BaseContract:
    x as u32;

function use_it:
    input r0 as BaseContract.private;
    output r0.x as u32.private;

constructor:
    assert.eq edition 0u16;
