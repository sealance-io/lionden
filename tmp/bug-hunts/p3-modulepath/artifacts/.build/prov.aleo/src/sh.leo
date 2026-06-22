// Module-scoped struct `sh::Env`. Short names keep the would-be external alias
// `Prov_Sh_Env` (11 bytes) under Leo's 31-byte identifier limit so the local
// collision is reachable.
struct Env {
    account: address,
    count: u32,
}
