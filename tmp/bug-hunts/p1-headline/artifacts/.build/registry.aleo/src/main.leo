program registry.aleo {
    @noupgrade
    constructor() {}

    struct TokenInfo {
        supply: u64,
        admin: address,
    }

    fn echo(info: TokenInfo) -> TokenInfo {
        return info;
    }
}
