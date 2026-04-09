program token.aleo {
    @noupgrade
    constructor() {}

    /// Public balances stored on-chain.
    mapping balances: address => u64;

    /// A private token record.
    record Token {
        owner: address,
        amount: u64,
    }

    /// Mint public tokens to a receiver.
    fn mint_public(public receiver: address, public amount: u64) -> Final {
        return final {
            let current: u64 = balances.get_or_use(receiver, 0u64);
            balances.set(receiver, current + amount);
        };
    }

    /// Transfer public tokens from signer to receiver.
    fn transfer_public(public receiver: address, public amount: u64) -> Final {
        let sender: address = self.signer;
        return final {
            let sender_balance: u64 = balances.get(sender);
            assert(sender_balance >= amount);
            balances.set(sender, sender_balance - amount);

            let receiver_balance: u64 = balances.get_or_use(receiver, 0u64);
            balances.set(receiver, receiver_balance + amount);
        };
    }

    /// Mint private tokens as a record.
    fn mint_private(receiver: address, amount: u64) -> Token {
        return Token {
            owner: receiver,
            amount: amount,
        };
    }

    /// Transfer private tokens by consuming input record and creating two new records.
    fn transfer_private(token: Token, receiver: address, amount: u64) -> (Token, Token) {
        let remaining: u64 = token.amount - amount;
        let to_receiver: Token = Token {
            owner: receiver,
            amount: amount,
        };
        let to_sender: Token = Token {
            owner: token.owner,
            amount: remaining,
        };
        return (to_receiver, to_sender);
    }
}
