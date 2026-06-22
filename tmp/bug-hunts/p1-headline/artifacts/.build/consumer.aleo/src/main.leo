// P1 (headline): consumer declares LOCAL structs named exactly like the would-be
// external aliases (`Registry_TokenInfo` for registry.aleo::TokenInfo, and
// `TokenRegistry_Token` for the token_registry.aleo::Token record) so the fix
// must bump the imports to `Registry_TokenInfo_` / `TokenRegistry_Token_`.
import registry.aleo;
import token_registry.aleo;

program consumer.aleo {
    @noupgrade
    constructor() {}

    struct Registry_TokenInfo {
        a: u64,
    }

    struct TokenRegistry_Token {
        b: u64,
    }

    fn local_info(a: u64) -> Registry_TokenInfo {
        return Registry_TokenInfo { a };
    }

    fn local_tok(b: u64) -> TokenRegistry_Token {
        return TokenRegistry_Token { b };
    }

    // struct path: round-trips the external struct through
    // serializeRegistry_TokenInfo_ / deserializeRegistry_TokenInfo_.
    fn relay(info: registry.aleo::TokenInfo) -> registry.aleo::TokenInfo {
        return info;
    }

    // record path: id-only external record handle (TokenRegistry_Token_).
    fn forward(t: token_registry.aleo::Token) -> token_registry.aleo::Token {
        return t;
    }
}
