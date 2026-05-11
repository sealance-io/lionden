import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createBubblesort } from "../typechain/Bubblesort.js";

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
  const bubblesort = createBubblesort();

  beforeAll(() => {
    bubblesort.connect(ctx!.lre);
  });

  it("sorts a reverse-ordered array", async () => {
    const sorted = await bubblesort.bubble_sort([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("leaves an already-sorted array alone", async () => {
    const sorted = await bubblesort.bubble_sort([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
