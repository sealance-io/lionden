program prov.aleo {
    @noupgrade
    constructor() {}

    fn envelope_echo(e: sh::Env) -> sh::Env {
        return e;
    }
}
