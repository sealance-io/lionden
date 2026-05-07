// The number of votes required to approve a checksum.
const THRESHOLD: u32 = 2u32;

program basic_voting.aleo {
    mapping proposed_checksum: bool => [u8; 32];
    mapping approved_checksum: bool => [u8; 32];
    mapping accepting_votes: bool => u32;
    mapping voters: address => bool;

    @noupgrade
    constructor() {}

    fn propose(checksum: [u8; 32]) -> Final {
        return final {
            assert(!proposed_checksum.contains(true));
            assert(!approved_checksum.contains(true));
        };
    }

    fn vote(checksum: [u8; 32], approved: bool) -> Final {
        let caller: address = self.caller;
        return final {
            assert(proposed_checksum.contains(true));
            assert(!approved_checksum.contains(true));
            assert(!voters.contains(caller));

            voters.set(caller, true);

            if (approved) {
                let current_votes: u32 = accepting_votes.get(true);
                let new_votes: u32 = current_votes + 1u32;
                accepting_votes.set(true, new_votes);

                if (new_votes >= THRESHOLD) {
                    approved_checksum.set(true, checksum);
                }
            }
        };
    }
}
