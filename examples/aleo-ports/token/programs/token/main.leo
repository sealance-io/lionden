program token.aleo {
    @noupgrade
    constructor() {}

    /// Public balance per address.
    mapping account: address => u64;

    record Token {
        owner: address,
        amount: u64,
    }

    // ---- Mint ----

    /// Public mint: increments account[receiver].
    fn mint_public(public receiver: address, public amount: u64) -> Final {
        return final {
            let current: u64 = Mapping::get_or_use(account, receiver, 0u64);
            Mapping::set(account, receiver, current + amount);
        };
    }

    /// Private mint: returns a fresh Token record assigned to receiver.
    fn mint_private(receiver: address, amount: u64) -> Token {
        return Token { owner: receiver, amount: amount };
    }

    // ---- Transfer ----

    /// Public-to-public transfer: decrement caller, increment receiver.
    fn transfer_public(public receiver: address, public amount: u64) -> Final {
        let caller: address = self.caller;
        return final {
            let sender_amount: u64 = Mapping::get_or_use(account, caller, 0u64);
            Mapping::set(account, caller, sender_amount - amount);
            let receiver_amount: u64 = Mapping::get_or_use(account, receiver, 0u64);
            Mapping::set(account, receiver, receiver_amount + amount);
        };
    }

    /// Private-to-private transfer: split a Token into (remainder, transferred).
    fn transfer_private(sender: Token, receiver: address, amount: u64) -> (Token, Token) {
        let difference: u64 = sender.amount - amount;
        let remaining: Token = Token { owner: sender.owner, amount: difference };
        let transferred: Token = Token { owner: receiver, amount: amount };
        return (remaining, transferred);
    }

    /// Private-to-public: keep remainder as Token, increment account[receiver].
    fn transfer_private_to_public(sender: Token, public receiver: address, public amount: u64) -> (Token, Final) {
        let difference: u64 = sender.amount - amount;
        let remaining: Token = Token { owner: sender.owner, amount: difference };
        return (remaining, final {
            let current: u64 = Mapping::get_or_use(account, receiver, 0u64);
            Mapping::set(account, receiver, current + amount);
        });
    }

    /// Public-to-private: emit a Token to receiver, decrement caller's account.
    fn transfer_public_to_private(public receiver: address, public amount: u64) -> (Token, Final) {
        let transferred: Token = Token { owner: receiver, amount: amount };
        let caller: address = self.caller;
        return (transferred, final {
            let current: u64 = Mapping::get_or_use(account, caller, 0u64);
            Mapping::set(account, caller, current - amount);
        });
    }
}
