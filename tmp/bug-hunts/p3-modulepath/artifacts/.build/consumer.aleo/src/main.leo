// P3: consumer references a MODULE-SCOPED external struct path
// (`prov.aleo::sh::Env`, baseName `Sh_Env`, alias `Prov_Sh_Env`) AND declares a
// local struct named exactly `Prov_Sh_Env`. The fix must bump the external alias
// to `Prov_Sh_Env_` while leaving the local interface unaliased.
import prov.aleo;

program consumer.aleo {
    @noupgrade
    constructor() {}

    struct Prov_Sh_Env {
        tag: u32,
    }

    fn local_make(tag: u32) -> Prov_Sh_Env {
        return Prov_Sh_Env { tag };
    }

    fn relay(e: prov.aleo::sh::Env) -> prov.aleo::sh::Env {
        return e;
    }
}
