program leo_field_holder.aleo;

struct LeoField:
    x as u32;

function use_it:
    input r0 as LeoField.private;
    output r0.x as u32.private;

constructor:
    assert.eq edition 0u16;
