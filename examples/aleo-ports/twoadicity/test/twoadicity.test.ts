import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

async function deployTwoadicity() {
  const ctx = await setup();
  try {
    await ctx.deploy("twoadicity", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployTwoadicity);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("twoadicity.aleo", () => {
  // The 252-bounded loop with field division is expensive even in local mode —
  // each call synthesizes a large circuit. We exercise a small representative
  // set of inputs (odd, low power-of-two, low non-power) rather than a
  // saturating sweep.
  it("twoadicity(1) = 0 (odd)", async () => {
    const result = await ctx!.execute("twoadicity.aleo", "main", ["1field"], { mode: "local" });
    expect(result.outputs[0]).toBe("0u8");
  }, 180_000);

  it("twoadicity(8) = 3 (2^3)", async () => {
    const result = await ctx!.execute("twoadicity.aleo", "main", ["8field"], { mode: "local" });
    expect(result.outputs[0]).toBe("3u8");
  }, 180_000);

  it("twoadicity(12) = 2 (4·3)", async () => {
    const result = await ctx!.execute("twoadicity.aleo", "main", ["12field"], { mode: "local" });
    expect(result.outputs[0]).toBe("2u8");
  }, 180_000);
});
