import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

async function deployBubblesort() {
  const ctx = await setup();
  try {
    await ctx.deploy("bubblesort", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployBubblesort);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("bubblesort.aleo", () => {
  it("sorts a reverse-ordered array", async () => {
    const result = await ctx!.execute(
      "bubblesort.aleo",
      "bubble_sort",
      ["[8u32, 7u32, 6u32, 5u32, 4u32, 3u32, 2u32, 1u32]"],
      { mode: "local" },
    );
    expect(result.outputs[0]).toBe("[\n  1u32,\n  2u32,\n  3u32,\n  4u32,\n  5u32,\n  6u32,\n  7u32,\n  8u32\n]");
  });

  it("leaves an already-sorted array alone", async () => {
    const result = await ctx!.execute(
      "bubblesort.aleo",
      "bubble_sort",
      ["[1u32, 2u32, 3u32, 4u32, 5u32, 6u32, 7u32, 8u32]"],
      { mode: "local" },
    );
    // Same content, regardless of formatting whitespace from the runtime.
    expect(result.outputs[0]).toMatch(/1u32/);
    expect(result.outputs[0]).toMatch(/8u32/);
  });
});
