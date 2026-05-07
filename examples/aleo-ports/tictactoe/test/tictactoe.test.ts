// Port of tmp/leo-examples/tictactoe/. Upstream run.sh choreographs an
// 8-move 2-player game. The port exercises:
//   1. new() returns an empty Board
//   2. make_move() chains nested struct outputs back as inputs
//   3. A 3-move row-1 sweep by player 1 ends with winner = 1u8
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

const EMPTY_BOARD =
  "{ r1: { c1: 0u8, c2: 0u8, c3: 0u8 }, r2: { c1: 0u8, c2: 0u8, c3: 0u8 }, r3: { c1: 0u8, c2: 0u8, c3: 0u8 } }";

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
  it("new() returns an empty board (all 0u8)", async () => {
    const result = await ctx!.execute("tictactoe.aleo", "new", [], { mode: "local" });
    const board = result.outputs[0]!;
    // The literal contains nine `0u8` cells.
    expect(board.match(/0u8/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
  });

  it("make_move places player 1 in (1,1) and reports no winner yet", async () => {
    const result = await ctx!.execute(
      "tictactoe.aleo",
      "make_move",
      ["1u8", "1u8", "1u8", EMPTY_BOARD],
      { mode: "local" },
    );

    expect(result.outputs).toHaveLength(2);
    const winner = result.outputs[1]!;
    expect(winner).toBe("0u8");
  });

  it("player 1 wins by completing row 1 across three moves", async () => {
    // Move 1: player 1 takes (1,1).
    const m1 = await ctx!.execute(
      "tictactoe.aleo",
      "make_move",
      ["1u8", "1u8", "1u8", EMPTY_BOARD],
      { mode: "local" },
    );
    expect(m1.outputs[1]).toBe("0u8");
    const board1 = m1.outputs[0]!;

    // Move 2: player 1 takes (1,2). (Skipping player 2's interleaving for parity-test brevity.)
    const m2 = await ctx!.execute(
      "tictactoe.aleo",
      "make_move",
      ["1u8", "1u8", "2u8", board1],
      { mode: "local" },
    );
    expect(m2.outputs[1]).toBe("0u8");
    const board2 = m2.outputs[0]!;

    // Move 3: player 1 completes row 1 by taking (1,3).
    const m3 = await ctx!.execute(
      "tictactoe.aleo",
      "make_move",
      ["1u8", "1u8", "3u8", board2],
      { mode: "local" },
    );
    expect(m3.outputs[1]).toBe("1u8");
  });
});
