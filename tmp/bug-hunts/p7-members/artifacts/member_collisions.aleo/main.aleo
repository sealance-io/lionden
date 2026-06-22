program member_collisions.aleo;

mapping counts:
    key as address.public;
    value as u64.public;

function connect:
    input r0 as u32.private;
    output r0 as u32.private;

function withSigner:
    input r0 as u32.private;
    output r0 as u32.private;

function programId:
    input r0 as u32.private;
    output r0 as u32.private;

function mappings:
    input r0 as u32.private;
    output r0 as u32.private;

function bump:
    input r0 as address.public;
    async bump r0 into r1;
    output r1 as member_collisions.aleo/bump.future;

finalize bump:
    input r0 as address.public;
    get.or_use counts[r0] 0u64 into r1;
    add r1 1u64 into r2;
    set r2 into counts[r0];

constructor:
    assert.eq edition 0u16;
