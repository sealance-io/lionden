import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createFibonacci } from "../typechain/Fibonacci.js";

async function deployFibonacci() {
  const ctx = await setup();
  try {
    await ctx.deploy("fibonacci", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployFibonacci);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("fibonacci.aleo", () => {
  const fib = createFibonacci();

  beforeAll(() => {
    fib.connect(ctx!.lre);
  });

  // Reference values: F(0)=0, F(1)=1, F(2)=1, F(10)=55, F(20)=6765.
  // F(64) is dropped: it triggers a "Failed to download powers for degree
  // 65536" error in local proving (high-degree witness synthesis needs a
  // larger proving key than the SDK ships with by default).
  it.each([
    [0, 0n],
    [1, 1n],
    [2, 1n],
    [10, 55n],
    [20, 6765n],
  ] as const)("fibonacci(%i) = %s", async (n, expected) => {
    expect(await fib.fibonacci(n)).toBe(expected);
  });
});
