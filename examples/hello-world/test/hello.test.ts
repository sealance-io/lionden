import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHello } from "../typechain/Hello.js";

const hello = createHello();

async function deployHello() {
  const ctx = await setup();
  try {
    await ctx.deploy(hello, { noCompile: true });
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
  beforeAll(() => {
    hello.connect(ctx!.lre);
  });

  it("adds two numbers", async () => {
    expect(await hello.main.locally({ arg0: 3, arg1: 5 })).toBe(8);
  });

  it("multiplies two numbers", async () => {
    expect(await hello.multiply.locally({ arg0: 4, arg1: 7 })).toBe(28);
  });

  it("handles zero", async () => {
    expect(await hello.main.locally({ arg0: 0, arg1: 42 })).toBe(42);
  });
});
