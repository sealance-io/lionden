// Port of tmp/leo-examples/battleship/. Multi-program: battleship.aleo
// imports board.aleo, move.aleo, verify.aleo. All transitions are pure
// (no Final), so local mode + chained records throughout.
//
// Test scope: one round-trip per transition (initialize_board → offer →
// start → play). The full 8-turn game is narrative, not parity. Ship
// coordinates come from upstream run.sh's known-good Player 1 placement.
//
// Typed-wrapper coverage caveat: battleship.aleo's transitions return
// records that live in the IMPORTED programs (BoardState in board.aleo,
// Move in move.aleo). The codegen for battleship doesn't have those type
// definitions in scope, so it falls back to Promise<string>. That's still
// a real win — bigint args are typed and the call site no longer has the
// program ID + transition name as raw strings — but the record-content
// assertions stay as `expect(literal).toContain(...)` against the raw
// record literal returned by the wrapper.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createBattleship } from "../typechain/Battleship.js";
import { createVerify } from "../typechain/Verify.js";

// Player 1's ship coordinates from upstream run.sh:
// carrier=34084860461056, battleship=551911718912, cruiser=7, destroyer=1157425104234217472.
const CARRIER = 34084860461056n;
const BATTLESHIP_SHIP = 551911718912n;
const CRUISER = 7n;
const DESTROYER = 1157425104234217472n;

async function deployBattleship() {
  const ctx = await setup();
  try {
    // Deploying battleship transitively deploys board, move, verify in
    // topological order (per packages/leo-compiler dependency-resolver).
    await ctx.deploy("battleship", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployBattleship);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("battleship multi-program", () => {
  const battleship = createBattleship();
  const verify = createVerify();
  const player1 = () => ctx!.accounts[0]!;
  const player2 = () => ctx!.accounts[1]!;

  beforeAll(() => {
    battleship.connect(ctx!.lre);
    verify.connect(ctx!.lre);
  });

  // Captured across tests so the round-trip can be inspected piecewise.
  // Imported-record outputs are returned as opaque strings (see header).
  let board1Initial: string | undefined;
  let board1Started: string | undefined;
  let dummyMoveForP2: string | undefined;
  let board2Started: string | undefined;
  let dummyMoveForP1: string | undefined;

  it("verify.aleo::validate_ship accepts a valid horizontal placement", async () => {
    expect(await verify.validate_ship(CARRIER, 5n, 31n, 4311810305n)).toBe(true);
  });

  it("verify.aleo::create_board OR's the four ships into one bitstring", async () => {
    // Expect popcount 14; combined value per upstream run.sh comments.
    expect(await verify.create_board(CARRIER, BATTLESHIP_SHIP, CRUISER, DESTROYER)).toBe(
      1157459741006397447n,
    );
  });

  it("battleship.aleo::initialize_board (player 1) returns a fresh BoardState", async () => {
    board1Initial = await battleship
      .withSigner(player1())
      .initialize_board(CARRIER, BATTLESHIP_SHIP, CRUISER, DESTROYER, player2().address);
    expect(board1Initial).toContain("game_started: false");
    expect(board1Initial).toContain(player1().address);
    expect(board1Initial).toContain(player2().address);
  });

  it("battleship.aleo::offer_battleship marks the board as started and emits a dummy Move for player 2", async () => {
    expect(board1Initial, "initialize_board must run first").toBeDefined();

    const [started, move] = await battleship
      .withSigner(player1())
      .offer_battleship(board1Initial!);
    board1Started = started;
    dummyMoveForP2 = move;

    expect(board1Started).toContain("game_started: true");
    // Dummy move owned by player 2.
    expect(dummyMoveForP2).toContain(player2().address);
  });

  it("battleship.aleo::start_battleship (player 2) starts their board and emits dummy Move back to player 1", async () => {
    expect(dummyMoveForP2).toBeDefined();

    // Player 2 initializes their own board (with player 1 as opponent).
    // Reusing player 1's coords for simplicity — different ships placement
    // would be 2 different valid bitstrings; not necessary for parity.
    const board2Initial = await battleship
      .withSigner(player2())
      .initialize_board(CARRIER, BATTLESHIP_SHIP, CRUISER, DESTROYER, player1().address);

    const [started, move] = await battleship
      .withSigner(player2())
      .start_battleship(board2Initial, dummyMoveForP2!);
    board2Started = started;
    dummyMoveForP1 = move;

    expect(board2Started).toContain("game_started: true");
    expect(dummyMoveForP1).toContain(player1().address);
  });

  it("battleship.aleo::play (player 1's first turn) updates board and emits next Move for player 2", async () => {
    expect(board1Started).toBeDefined();
    expect(dummyMoveForP1).toBeDefined();

    // Shoot at bit 0 (single-bit u64 = 1).
    const [nextBoard, nextMove] = await battleship
      .withSigner(player1())
      .play(board1Started!, dummyMoveForP1!, 1n);

    expect(nextBoard).toContain("game_started: true");
    // Next move is owned by the opponent (player 2).
    expect(nextMove).toContain(player2().address);
  });
});
