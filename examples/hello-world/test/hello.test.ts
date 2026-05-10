import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createHello } from "../typechain/Hello.js";

async function deployHello() {
  const ctx = await setup();
  try {
    await ctx.deploy("hello", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployHello);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("hello program", () => {
  const hello = createHello();

  beforeAll(() => {
    hello.connect(ctx!.lre);
  });

  it("adds two numbers", async () => {
    expect(await hello.main(3, 5)).toBe(8);
  });

  it("multiplies two numbers", async () => {
    expect(await hello.multiply(4, 7)).toBe(28);
  });

  it("handles zero", async () => {
    expect(await hello.main(0, 42)).toBe(42);
  });
});
