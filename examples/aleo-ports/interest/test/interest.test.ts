import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createInterest } from "../typechain/Interest.js";

async function deployInterest() {
  const ctx = await setup();
  try {
    await ctx.deploy("interest", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployInterest);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("interest.aleo", () => {
  const interest = createInterest();

  beforeAll(() => {
    interest.connect(ctx!.lre);
  });

  // 100 capital at 10% over 10 iterations, with floor division at each step:
  // round-down compounding produces 100 → 110 → 121 → 133 → 146 → 160 → 176 → 193 → 212 → 233 → 256.
  it("fixed_iteration_interest compounds 10 rounds", async () => {
    expect(await interest.fixed_iteration_interest.locally({ capital: 100, rate: 10 })).toBe(256);
  });

  // Zero rate is a no-op.
  it("fixed_iteration_interest is a no-op at 0% rate", async () => {
    expect(await interest.fixed_iteration_interest.locally({ capital: 100, rate: 0 })).toBe(100);
  });

  // bounded_iteration_interest with 0 iterations should return capital unchanged.
  it("bounded_iteration_interest with 0 iterations returns capital", async () => {
    expect(await interest.bounded_iteration_interest.locally({
      capital: 100,
      rate: 10,
      iterations: 0,
    })).toBe(100);
  });

  // bounded_iteration_interest over 10 iterations should match fixed_iteration_interest.
  it("bounded_iteration_interest matches fixed at 10 iterations", async () => {
    expect(await interest.bounded_iteration_interest.locally({
      capital: 100,
      rate: 10,
      iterations: 10,
    })).toBe(256);
  });
});
