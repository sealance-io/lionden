import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHello } from "../typechain/Hello.js";
import { createHelloworld } from "../typechain/Helloworld.js";

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
    expect(await helloworld.main.locally(3, 5)).toBe(8);
  });
});

describe("hello.aleo", () => {
  const hello = createHello();

  beforeAll(() => {
    hello.connect(ctx!.lre);
  });

  it("adds two u32s", async () => {
    expect(await hello.main.locally(1, 2)).toBe(3);
  });
});
