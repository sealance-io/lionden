program board.aleo {
    @noupgrade
    constructor() {}

    record BoardState {
        owner: address,
        hits_and_misses: u64,
        played_tiles: u64,
        ships: u64,
        player_1: address,
        player_2: address,
        game_started: bool,
    }

    // Upstream uses `self.caller` here. That works in `leo run` (single-
    // program local runner) but breaks under real cross-program execution
    // via the SDK: when battleship.aleo invokes board.aleo, self.caller
    // becomes battleship.aleo's program address, not the human signer —
    // so the resulting record can't be re-spent by the signer.
    // Using self.signer keeps ownership tied to the original signer.
    fn new_board_state(ships: u64, opponent: address) -> BoardState {
        return BoardState {
            owner: self.signer,
            hits_and_misses: 0u64,
            played_tiles: 0u64,
            ships,
            player_1: self.signer,
            player_2: opponent,
            game_started: false,
        };
    }

    /// Mark the board as started (one-shot — fails if already started).
    fn start_board(board: BoardState) -> BoardState {
        assert(!board.game_started);
        return BoardState {
            owner: board.owner,
            hits_and_misses: board.hits_and_misses,
            played_tiles: board.played_tiles,
            ships: board.ships,
            player_1: board.player_1,
            player_2: board.player_2,
            game_started: true,
        };
    }

    /// OR `shoot` into played_tiles. Asserts that `shoot` is a single bit
    /// and doesn't overlap previously-played tiles.
    fn update_played_tiles(board: BoardState, shoot: u64) -> BoardState {
        let flip_bit: u64 = shoot - 1u64;
        let check_move: u64 = shoot & flip_bit;
        assert_eq(check_move, 0u64);

        let check_tiles: u64 = shoot & board.played_tiles;
        assert_eq(check_tiles, 0u64);

        let played_tiles: u64 = board.played_tiles | shoot;

        return BoardState {
            owner: board.owner,
            hits_and_misses: board.hits_and_misses,
            played_tiles,
            ships: board.ships,
            player_1: board.player_1,
            player_2: board.player_2,
            game_started: board.game_started,
        };
    }

    /// OR `hit_or_miss` into hits_and_misses.
    fn update_hits_and_misses(board: BoardState, hit_or_miss: u64) -> BoardState {
        let hits_and_misses: u64 = board.hits_and_misses | hit_or_miss;
        return BoardState {
            owner: board.owner,
            hits_and_misses,
            played_tiles: board.played_tiles,
            ships: board.ships,
            player_1: board.player_1,
            player_2: board.player_2,
            game_started: board.game_started,
        };
    }
}
