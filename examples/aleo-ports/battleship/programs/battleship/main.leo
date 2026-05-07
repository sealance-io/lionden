import board.aleo;
import move.aleo;
import verify.aleo;

program battleship.aleo {
    @noupgrade
    constructor() {}

    /// Validate four ship placements, combine them into a board, and emit a
    /// fresh BoardState record.
    fn initialize_board(
        carrier: u64,
        battleship: u64,
        cruiser: u64,
        destroyer: u64,
        player: address,
    ) -> board.aleo::BoardState {
        let valid_carrier: bool = verify.aleo::validate_ship(carrier, 5u64, 31u64, 4311810305u64);
        assert(valid_carrier);

        let valid_battleship: bool = verify.aleo::validate_ship(battleship, 4u64, 15u64, 16843009u64);
        assert(valid_battleship);

        let valid_cruiser: bool = verify.aleo::validate_ship(cruiser, 3u64, 7u64, 65793u64);
        assert(valid_cruiser);

        let valid_destroyer: bool = verify.aleo::validate_ship(destroyer, 2u64, 3u64, 257u64);
        assert(valid_destroyer);

        let board: u64 = verify.aleo::create_board(carrier, battleship, cruiser, destroyer);
        let state: board.aleo::BoardState = board.aleo::new_board_state(board, player);
        return state;
    }

    /// Mark the board as started and emit a dummy move owned by player_2.
    fn offer_battleship(board: board.aleo::BoardState) -> (board.aleo::BoardState, move.aleo::Move) {
        let state: board.aleo::BoardState = board.aleo::start_board(board);
        let dummy: move.aleo::Move = move.aleo::start_game(board.player_2);
        return (state, dummy);
    }

    /// Player 2 confirms by also starting their board and sending a dummy
    /// move back. Asserts player_1/player_2 alignment between board and move.
    fn start_battleship(
        board: board.aleo::BoardState,
        move_start: move.aleo::Move,
    ) -> (board.aleo::BoardState, move.aleo::Move) {
        assert_eq(board.player_1, move_start.player_2);
        assert_eq(board.player_2, move_start.player_1);

        let state: board.aleo::BoardState = board.aleo::start_board(board);
        let dummy: move.aleo::Move = move.aleo::start_game(board.player_2);
        return (state, dummy);
    }

    /// Take a turn: register the incoming move's prev_hit_or_miss, fire a
    /// new shoot at the opponent, and emit the next Move.
    fn play(
        board: board.aleo::BoardState,
        move_incoming: move.aleo::Move,
        shoot: u64,
    ) -> (board.aleo::BoardState, move.aleo::Move) {
        assert(board.game_started);
        assert_eq(board.player_1, move_incoming.player_2);
        assert_eq(board.player_2, move_incoming.player_1);

        let hit_or_miss: board.aleo::BoardState = board.aleo::update_played_tiles(board, shoot);
        let next_board: board.aleo::BoardState = board.aleo::update_hits_and_misses(hit_or_miss, move_incoming.prev_hit_or_miss);

        let is_hit: u64 = move_incoming.incoming_fire_coordinate & board.ships;
        let next_move: move.aleo::Move = move.aleo::create_move(move_incoming, shoot, is_hit);

        return (next_board, next_move);
    }
}
