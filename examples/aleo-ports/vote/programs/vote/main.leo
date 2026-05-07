struct ProposalInfo {
    title: field,
    content: field,
    proposer: address,
}

program vote.aleo {
    @noupgrade
    constructor() {}

    record Proposal {
        owner: address,
        id: field,
        info: ProposalInfo,
    }

    record Ticket {
        owner: address,
        pid: field,
    }

    mapping proposals: field => ProposalInfo;
    mapping tickets: field => u64;
    mapping agree_votes: field => u64;
    mapping disagree_votes: field => u64;

    /// Open a new proposal. The signer must match `info.proposer`. Initializes
    /// `tickets[id]` to 0.
    fn propose(public info: ProposalInfo) -> (Proposal, Final) {
        assert_eq(self.caller, info.proposer);
        let id: field = BHP256::hash_to_field(info.title);
        return (Proposal { owner: self.caller, id, info }, final {
            Mapping::set(tickets, id, 0u64);
        });
    }

    /// Issue a voting ticket for a given proposal id. Increments `tickets[pid]`.
    fn new_ticket(public pid: field, public voter: address) -> (Ticket, Final) {
        return (
            Ticket { owner: voter, pid },
            final {
                let current: u64 = Mapping::get_or_use(tickets, pid, 0u64);
                Mapping::set(tickets, pid, current + 1u64);
            }
        );
    }

    /// Cast an agreeing vote — increments `agree_votes[pid]`.
    fn agree(ticket: Ticket) -> Final {
        let pid: field = ticket.pid;
        return final {
            let current: u64 = Mapping::get_or_use(agree_votes, pid, 0u64);
            Mapping::set(agree_votes, pid, current + 1u64);
        };
    }

    /// Cast a disagreeing vote — increments `disagree_votes[pid]`.
    fn disagree(ticket: Ticket) -> Final {
        let pid: field = ticket.pid;
        return final {
            let current: u64 = Mapping::get_or_use(disagree_votes, pid, 0u64);
            Mapping::set(disagree_votes, pid, current + 1u64);
        };
    }
}
