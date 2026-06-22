// Consumer declares a LOCAL record `Receipt` (the helper's sourceRecord, routing
// the helper into THIS module) AND uses the external `gold_token.aleo::Token`
// (emitting `export const GoldToken_Token` here). The helper, named
// `GoldToken_Token`, also emits `export const GoldToken_Token` -> duplicate.
import gold_token.aleo;

program consumer.aleo {
    @noupgrade
    constructor() {}

    record Receipt {
        owner: address,
        amount: u64,
    }

    fn issue(amount: u64) -> Receipt {
        return Receipt { owner: self.signer, amount };
    }

    fn forward(t: gold_token.aleo::Token) -> gold_token.aleo::Token {
        return t;
    }
}
