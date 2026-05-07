import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

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
  // Reference values: F(0)=0, F(1)=1, F(2)=1, F(10)=55, F(20)=6765.
  // F(64) is dropped: it triggers a "Failed to download powers for degree
  // 65536" error in local proving (high-degree witness synthesis needs a
  // larger proving key than the SDK ships with by default).
  it.each([
    ["0u8", "0u128"],
    ["1u8", "1u128"],
    ["2u8", "1u128"],
    ["10u8", "55u128"],
    ["20u8", "6765u128"],
  ])("fibonacci(%s) = %s", async (n, expected) => {
    const result = await ctx!.execute("fibonacci.aleo", "fibonacci", [n], { mode: "local" });
    expect(result.outputs[0]).toBe(expected);
  });
});
