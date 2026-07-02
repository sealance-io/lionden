import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    expect(await message.main.locally({ first: 2n, second: 3n })).toBe("5field");
  });

  it("handles zero values", async () => {
    expect(await message.main.locally({ first: 0n, second: 0n })).toBe("0field");
  });
});
