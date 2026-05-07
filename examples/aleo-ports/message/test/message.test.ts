import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

async function deployMessage() {
  const ctx = await setup();
  try {
    await ctx.deploy("message", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployMessage);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("message.aleo", () => {
  // Struct args are passed as Leo struct literals — first + second.
  it("main returns first + second", async () => {
    const result = await ctx!.execute(
      "message.aleo",
      "main",
      ["{ first: 2field, second: 3field }"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("5field");
  });

  it("handles zero values", async () => {
    const result = await ctx!.execute(
      "message.aleo",
      "main",
      ["{ first: 0field, second: 0field }"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("0field");
  });
});
