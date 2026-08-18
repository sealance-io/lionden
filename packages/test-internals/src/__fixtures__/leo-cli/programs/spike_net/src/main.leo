// Depends on an already-on-chain *network* program (credits.aleo). Used to
// answer the second half of spike question 3: does Leo attempt to deploy
// network dependencies, i.e. do they need `--skip` too?
import credits.aleo;

program spike_net.aleo {
    @noupgrade
    constructor() {}

    fn pay(public to: address, public amount: u64) -> Final {
        let f: Final = credits.aleo::transfer_public(to, amount);
        return final {
            f.run();
        };
    }
}
