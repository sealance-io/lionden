import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createMessageContract } from "../typechain/Message.js";

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
  const message = createMessageContract();

  beforeAll(() => {
    message.connect(ctx!.lre);
  });

  it("main returns first + second", async () => {
    expect(await message.main({ first: "2field", second: "3field" })).toBe("5field");
  });

  it("handles zero values", async () => {
    expect(await message.main({ first: "0field", second: "0field" })).toBe("0field");
  });
});
