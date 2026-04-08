import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, type TestContext } from "@lionden/testing";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();
  await ctx.deploy("hello");
});

afterAll(async () => {
  await ctx.teardown();
});

describe("hello program", () => {
  it("adds two numbers", async () => {
    const result = await ctx.execute("hello.aleo", "main", ["3u32", "5u32"]);
    expect(result.outputs[0]).toBe("8u32");
  });

  it("multiplies two numbers", async () => {
    const result = await ctx.execute("hello.aleo", "multiply", ["4u32", "7u32"]);
    expect(result.outputs[0]).toBe("28u32");
  });

  it("handles zero", async () => {
    const result = await ctx.execute("hello.aleo", "main", ["0u32", "42u32"]);
    expect(result.outputs[0]).toBe("42u32");
  });
});
