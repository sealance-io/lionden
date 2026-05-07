import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

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
  it("adds two u32s", async () => {
    const result = await ctx!.execute("helloworld.aleo", "main", ["3u32", "5u32"], { mode: "local" });
    expect(result.outputs[0]).toBe("8u32");
  });
});

describe("hello.aleo", () => {
  it("adds two u32s", async () => {
    const result = await ctx!.execute("hello.aleo", "main", ["1u32", "2u32"], { mode: "local" });
    expect(result.outputs[0]).toBe("3u32");
  });
});
