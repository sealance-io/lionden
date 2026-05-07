// Port of tmp/leo-examples/battleship/. Multi-program: battleship.aleo
// imports board.aleo, move.aleo, verify.aleo. All transitions are pure
// (no Final), so local mode + chained records throughout.
//
// Test scope: one round-trip per transition (initialize_board → offer →
// start → play). The full 8-turn game is narrative, not parity. Ship
// coordinates come from upstream run.sh's known-good Player 1 placement.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

// Player 1's ship coordinates from upstream run.sh:
// carrier=34084860461056, battleship=551911718912, cruiser=7, destroyer=1157425104234217472.
const CARRIER = "34084860461056u64";
const BATTLESHIP_SHIP = "551911718912u64";
const CRUISER = "7u64";
const DESTROYER = "1157425104234217472u64";

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
  const player1 = () => ctx!.accounts[0]!;
  const player2 = () => ctx!.accounts[1]!;

  // Captured across tests so the round-trip can be inspected piecewise.
  let board1Initial: string | undefined;
  let board1Started: string | undefined;
  let dummyMoveForP2: string | undefined;
  let board2Started: string | undefined;
  let dummyMoveForP1: string | undefined;

  it("verify.aleo::validate_ship accepts a valid horizontal placement", async () => {
    const result = await ctx!.execute(
      "verify.aleo",
      "validate_ship",
      [CARRIER, "5u64", "31u64", "4311810305u64"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("true");
  });

  it("verify.aleo::create_board OR's the four ships into one bitstring", async () => {
    const result = await ctx!.execute(
      "verify.aleo",
      "create_board",
      [CARRIER, BATTLESHIP_SHIP, CRUISER, DESTROYER],
      { mode: "local" },
    );
    // Expect popcount 14; combined value per upstream run.sh comments.
    expect(result.outputs[0]).toBe("1157459741006397447u64");
  });

  it("battleship.aleo::initialize_board (player 1) returns a fresh BoardState", async () => {
    const result = await ctx!.execute(
      "battleship.aleo",
      "initialize_board",
      [CARRIER, BATTLESHIP_SHIP, CRUISER, DESTROYER, player2().address],
      { mode: "local", signer: player1() },
    );
    board1Initial = result.outputs[0]!;
    expect(board1Initial).toContain("game_started: false");
    expect(board1Initial).toContain(player1().address);
    expect(board1Initial).toContain(player2().address);
  });

  it("battleship.aleo::offer_battleship marks the board as started and emits a dummy Move for player 2", async () => {
    expect(board1Initial, "initialize_board must run first").toBeDefined();

    const result = await ctx!.execute(
      "battleship.aleo",
      "offer_battleship",
      [board1Initial!],
      { mode: "local", signer: player1() },
    );
    expect(result.outputs).toHaveLength(2);
    board1Started = result.outputs[0]!;
    dummyMoveForP2 = result.outputs[1]!;

    expect(board1Started).toContain("game_started: true");
    // Dummy move owned by player 2.
    expect(dummyMoveForP2).toContain(player2().address);
  });

  it("battleship.aleo::start_battleship (player 2) starts their board and emits dummy Move back to player 1", async () => {
    expect(dummyMoveForP2).toBeDefined();

    // Player 2 initializes their own board (with player 1 as opponent).
    // Reusing player 1's coords for simplicity — different ships placement
    // would be 2 different valid bitstrings; not necessary for parity.
    const initP2 = await ctx!.execute(
      "battleship.aleo",
      "initialize_board",
      [CARRIER, BATTLESHIP_SHIP, CRUISER, DESTROYER, player1().address],
      { mode: "local", signer: player2() },
    );
    const board2Initial = initP2.outputs[0]!;

    const result = await ctx!.execute(
      "battleship.aleo",
      "start_battleship",
      [board2Initial, dummyMoveForP2!],
      { mode: "local", signer: player2() },
    );
    expect(result.outputs).toHaveLength(2);
    board2Started = result.outputs[0]!;
    dummyMoveForP1 = result.outputs[1]!;

    expect(board2Started).toContain("game_started: true");
    expect(dummyMoveForP1).toContain(player1().address);
  });

  it("battleship.aleo::play (player 1's first turn) updates board and emits next Move for player 2", async () => {
    expect(board1Started).toBeDefined();
    expect(dummyMoveForP1).toBeDefined();

    // Shoot at bit 0 (single-bit u64 = 1u64).
    const result = await ctx!.execute(
      "battleship.aleo",
      "play",
      [board1Started!, dummyMoveForP1!, "1u64"],
      { mode: "local", signer: player1() },
    );
    expect(result.outputs).toHaveLength(2);
    const nextBoard = result.outputs[0]!;
    const nextMove = result.outputs[1]!;

    expect(nextBoard).toContain("game_started: true");
    // Next move is owned by the opponent (player 2).
    expect(nextMove).toContain(player2().address);
  });
});
