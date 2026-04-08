import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  type TestContext,
  assertMappingValue,
} from "@lionden/testing";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();
  await ctx.deploy("token");
});

afterAll(async () => {
  await ctx.teardown();
});

describe("token program", () => {
  describe("mint_public", () => {
    it("mints tokens to a receiver", async () => {
      // Use account-2 so this test is independent of others
      const receiver = ctx.accounts[2]!.address;
      await ctx.execute("token.aleo", "mint_public", [receiver, "1000u64"]);

      await assertMappingValue(
        ctx.connection,
        "token.aleo",
        "balances",
        receiver,
        "1000u64",
      );
    });
  });

  describe("transfer_public", () => {
    it("transfers tokens between accounts", async () => {
      // Use account-0 (sender) and account-3 (receiver) — isolated from other tests
      const sender = ctx.accounts[0]!.address;
      const receiver = ctx.accounts[3]!.address;

      // Mint initial tokens for sender
      await ctx.execute("token.aleo", "mint_public", [sender, "2000u64"]);

      // Transfer some to receiver
      await ctx.execute("token.aleo", "transfer_public", [receiver, "800u64"]);

      // Verify receiver got tokens
      await assertMappingValue(
        ctx.connection,
        "token.aleo",
        "balances",
        receiver,
        "800u64",
      );
    });
  });

  describe("mint_private", () => {
    it("returns a token record", async () => {
      const receiver = ctx.accounts[1]!.address;
      const result = await ctx.execute("token.aleo", "mint_private", [
        receiver,
        "500u64",
      ]);

      expect(result.outputs).toHaveLength(1);
      expect(result.txId).toBeDefined();
    });
  });

  describe("advanceBlocks", () => {
    it("advances blocks on the devnode", async () => {
      const heightBefore = await ctx.connection.getBlockHeight();
      await ctx.advanceBlocks(3);
      const heightAfter = await ctx.connection.getBlockHeight();

      expect(heightAfter).toBeGreaterThanOrEqual(heightBefore + 3);
    });
  });
});
