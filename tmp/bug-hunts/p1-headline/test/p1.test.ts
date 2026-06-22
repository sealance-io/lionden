import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";

import { createConsumer } from "../typechain/Consumer.js";
import { createTokenRegistry } from "../typechain/TokenRegistry.js";

async function deployAll() {
  const ctx = await setup({ skipDevnode: true });
  try {
    await ctx.deploy("registry", { noCompile: true });
    await ctx.deploy("token_registry", { noCompile: true });
    await ctx.deploy("consumer", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployAll);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) await ctx.teardown();
  else clearFixtures();
});

describe("P1: external alias disambiguation — runtime round-trips", () => {
  const consumer = createConsumer();
  const tokenRegistry = createTokenRegistry();

  beforeAll(() => {
    consumer.connect(ctx!.lre);
    tokenRegistry.connect(ctx!.lre);
  });

  it("struct path: relay round-trips the external struct (serializeRegistry_TokenInfo_)", async () => {
    const account = ctx!.accounts[0]!;
    const out = await consumer.relay.locally({ info: { supply: 100n, admin: account } });
    expect(out.supply).toBe(100n);
    expect(String(out.admin)).toBe(account.address);
  });

  it("record path: forward round-trips an external record via .locally()", async () => {
    const tok = await tokenRegistry.mint.locally({ amount: 7n });
    expect(tok.amount).toBe(7n);
    const out = await consumer.forward.locally({ t: tok });
    expect(out.amount).toBe(7n);
  });
});
