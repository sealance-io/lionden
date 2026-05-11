import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createMessageContract } from "../typechain/Message.js";
import { Leo } from "../typechain/BaseContract.js";

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
    expect(await message.main.locally({
      m: { first: Leo.field("2field"), second: Leo.field("3field") },
    })).toBe("5field");
  });

  it("handles zero values", async () => {
    expect(await message.main.locally({
      m: { first: Leo.field("0field"), second: Leo.field("0field") },
    })).toBe("0field");
  });
});
