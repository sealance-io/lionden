import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

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
  // 100 capital at 10% over 10 iterations, with floor division at each step:
  // round-down compounding produces 100 → 110 → 121 → 133 → 146 → 160 → 176 → 193 → 212 → 233 → 256.
  it("fixed_iteration_interest compounds 10 rounds", async () => {
    const result = await ctx!.execute(
      "interest.aleo",
      "fixed_iteration_interest",
      ["100u32", "10u32"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("256u32");
  });

  // Zero rate is a no-op.
  it("fixed_iteration_interest is a no-op at 0% rate", async () => {
    const result = await ctx!.execute(
      "interest.aleo",
      "fixed_iteration_interest",
      ["100u32", "0u32"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("100u32");
  });

  // bounded_iteration_interest with 0 iterations should return capital unchanged.
  it("bounded_iteration_interest with 0 iterations returns capital", async () => {
    const result = await ctx!.execute(
      "interest.aleo",
      "bounded_iteration_interest",
      ["100u32", "10u32", "0u8"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("100u32");
  });

  // bounded_iteration_interest over 10 iterations should match fixed_iteration_interest.
  it("bounded_iteration_interest matches fixed at 10 iterations", async () => {
    const result = await ctx!.execute(
      "interest.aleo",
      "bounded_iteration_interest",
      ["100u32", "10u32", "10u8"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("256u32");
  });
});
