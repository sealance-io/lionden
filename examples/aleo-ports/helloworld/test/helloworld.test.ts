import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createHelloworld } from "../typechain/Helloworld.js";
import { createHello } from "../typechain/Hello.js";

async function deployBoth() {
  const ctx = await setup();
  try {
    await ctx.deploy("helloworld", { noCompile: true });
    await ctx.deploy("hello", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployBoth);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("helloworld.aleo", () => {
  const helloworld = createHelloworld();

  beforeAll(() => {
    helloworld.connect(ctx!.lre);
  });

  it("adds two u32s", async () => {
    expect(await helloworld.main.locally({ a: 3, b: 5 })).toBe(8);
  });
});

describe("hello.aleo", () => {
  const hello = createHello();

  beforeAll(() => {
    hello.connect(ctx!.lre);
  });

  it("adds two u32s", async () => {
    expect(await hello.main.locally({ a: 1, b: 2 })).toBe(3);
  });
});
