import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLegacyContext } from "../typechain/LegacyContext.js";

const legacyContext = createLegacyContext();

async function deployLegacyContext() {
  const ctx = await setup();
  try {
    await ctx.deploy(legacyContext, { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployLegacyContext);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("legacy_context.aleo", () => {
  beforeAll(() => {
    legacyContext.connect(ctx!.lre);
  });

  it("returns the transaction signer through legacy self.signer syntax", async () => {
    expect(await legacyContext.get_signer.locally()).toBe(ctx!.accounts[0]!.address);
  });
});
