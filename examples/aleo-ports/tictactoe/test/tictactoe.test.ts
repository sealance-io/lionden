// Port of tmp/leo-examples/tictactoe/. Upstream run.sh choreographs an
// 8-move 2-player game. The port exercises:
//   1. new() returns an empty Board
//   2. make_move() chains nested struct outputs back as inputs
//   3. A 3-move row-1 sweep by player 1 ends with winner = 1

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Board, createTictactoe } from "../typechain/Tictactoe.js";

const EMPTY_BOARD: Board = {
  r1: { c1: 0, c2: 0, c3: 0 },
  r2: { c1: 0, c2: 0, c3: 0 },
  r3: { c1: 0, c2: 0, c3: 0 },
};

async function deployTicTacToe() {
  const ctx = await setup();
  try {
    await ctx.deploy("tictactoe", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployTicTacToe);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("tictactoe.aleo", () => {
  const ttt = createTictactoe();

  beforeAll(() => {
    ttt.connect(ctx!.lre);
  });

  it("new() returns an empty board (all 0)", async () => {
    const board = await ttt.new.locally();
    const cells = [
      board.r1.c1,
      board.r1.c2,
      board.r1.c3,
      board.r2.c1,
      board.r2.c2,
      board.r2.c3,
      board.r3.c1,
      board.r3.c2,
      board.r3.c3,
    ];
    expect(cells.every((c) => c === 0)).toBe(true);
  });

  it("make_move places player 1 in (1,1) and reports no winner yet", async () => {
    const [, winner] = await ttt.make_move.locally({
      player: 1,
      row: 1,
      col: 1,
      board: EMPTY_BOARD,
    });
    expect(winner).toBe(0);
  });

  it("player 1 wins by completing row 1 across three moves", async () => {
    // Move 1: player 1 takes (1,1).
    const [board1, w1] = await ttt.make_move.locally({
      player: 1,
      row: 1,
      col: 1,
      board: EMPTY_BOARD,
    });
    expect(w1).toBe(0);

    // Move 2: player 1 takes (1,2). (Skipping player 2's interleaving for parity-test brevity.)
    const [board2, w2] = await ttt.make_move.locally({
      player: 1,
      row: 1,
      col: 2,
      board: board1,
    });
    expect(w2).toBe(0);

    // Move 3: player 1 completes row 1 by taking (1,3).
    const [, w3] = await ttt.make_move.locally({
      player: 1,
      row: 1,
      col: 3,
      board: board2,
    });
    expect(w3).toBe(1);
  });
});
