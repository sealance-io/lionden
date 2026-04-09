program token.aleo {
    @noupgrade
    fn constructor() {}

    /// Public balances stored on-chain.
    mapping balances: address => u64;

    /// A private token record.
    record Token {
        owner: address,
        amount: u64,
    }

    /// Mint public tokens to the caller.
    fn mint_public(receiver: address, amount: u64) {
        let current: u64 = Mapping::get_or_use(balances, receiver, 0u64);
        Mapping::set(balances, receiver, current + amount);
    }

    /// Transfer public tokens from caller to receiver.
    fn transfer_public(receiver: address, amount: u64) {
        let sender: address = self.caller;

        let sender_balance: u64 = Mapping::get(balances, sender);
        assert(sender_balance >= amount);
        Mapping::set(balances, sender, sender_balance - amount);

        let receiver_balance: u64 = Mapping::get_or_use(balances, receiver, 0u64);
        Mapping::set(balances, receiver, receiver_balance + amount);
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
