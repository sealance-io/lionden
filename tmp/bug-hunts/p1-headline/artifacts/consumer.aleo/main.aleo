import registry.aleo;
import token_registry.aleo;
program consumer.aleo;

struct Registry_TokenInfo:
    a as u64;

struct TokenRegistry_Token:
    b as u64;

function local_info:
    input r0 as u64.private;
    cast r0 into r1 as Registry_TokenInfo;
    output r1 as Registry_TokenInfo.private;

function local_tok:
    input r0 as u64.private;
    cast r0 into r1 as TokenRegistry_Token;
    output r1 as TokenRegistry_Token.private;

function relay:
    input r0 as registry.aleo/TokenInfo.private;
    output r0 as registry.aleo/TokenInfo.private;

function forward:
    input r0 as token_registry.aleo/Token.record;
    output r0 as token_registry.aleo/Token.record;

constructor:
    assert.eq edition 0u16;
