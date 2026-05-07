program move.aleo {
    @noupgrade
    constructor() {}

    record Move {
        owner: address,
        incoming_fire_coordinate: u64,
        player_1: address,
        player_2: address,
        prev_hit_or_miss: u64,
    }

    /// Build the next move record, transferring ownership to the opponent
    /// and rotating player_1/player_2.
    fn create_move(move_record: Move, incoming_fire_coordinate: u64, prev_hit_or_miss: u64) -> Move {
        let one_is_owner: bool = move_record.player_1 == move_record.owner;
        let opponent: address = one_is_owner ? move_record.player_2 : move_record.player_1;

        return Move {
            owner: opponent,
            incoming_fire_coordinate,
            player_1: move_record.player_2,
            player_2: move_record.player_1,
            prev_hit_or_miss,
        };
    }

    // See note in board.aleo::new_board_state — `self.signer` instead of
    // `self.caller` so the move stays attributable to the human signer
    // when invoked through battleship.aleo.
    fn start_game(player_2: address) -> Move {
        return Move {
            owner: player_2,
            incoming_fire_coordinate: 0u64,
            player_1: self.signer,
            player_2: player_2,
            prev_hit_or_miss: 0u64,
        };
    }
}
