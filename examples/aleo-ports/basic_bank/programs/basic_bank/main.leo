program basic_bank.aleo {
    @noupgrade
    constructor() {}

    record Token {
        owner: address,
        amount: u64,
    }

    /// Per-account deposit balances, keyed by `BHP256::hash_to_field(address)`.
    mapping balances: field => u64;

    /// Bank-only: issue a fresh Token to `owner`. The hardcoded bank address
    /// is the upstream-fixed `aleo1rhgdu77…` (which happens to be lionden's
    /// devnode account-0).
    fn issue(owner: address, amount: u64) -> Token {
        assert_eq(self.caller, aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px);
        return Token { owner: owner, amount: amount };
    }

    /// Deposit `amount` from `token` into the bank. Returns the leftover
    /// Token to the depositor and increments balances[hash(owner)].
    fn deposit(token: Token, amount: u64) -> (Token, Final) {
        let difference: u64 = token.amount - amount;
        let remaining: Token = Token {
            owner: token.owner,
            amount: difference,
        };
        let hash: field = BHP256::hash_to_field(token.owner);
        return (
            remaining,
            final {
                let current: u64 = Mapping::get_or_use(balances, hash, 0u64);
                Mapping::set(balances, hash, current + amount);
            }
        );
    }

    /// Bank-only: withdraw with compound interest. Returns a Token paying
    /// out the principal+interest and decrements balances[hash(recipient)]
    /// by `amount` (the principal — interest is paid out, not deducted).
    fn withdraw(recipient: address, amount: u64, rate: u64, periods: u64) -> (Token, Final) {
        assert_eq(self.caller, aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px);
        let hash: field = BHP256::hash_to_field(recipient);
        let total: u64 = calculate_interest(amount, rate, periods);
        let token: Token = Token { owner: recipient, amount: total };
        return (
            token,
            final {
                let current: u64 = Mapping::get_or_use(balances, hash, 0u64);
                Mapping::set(balances, hash, current - amount);
            }
        );
    }
}

/// Compound `principal` at `rate` (basis points; rate / 10_000 per period)
/// over `periods` periods (max 100).
fn calculate_interest(principal: u64, rate: u64, periods: u64) -> u64 {
    let amount: u64 = principal;
    for i: u64 in 0u64..100u64 {
        if i < periods {
            amount += (amount * rate) / 10000u64;
        }
    }
    return amount;
}
