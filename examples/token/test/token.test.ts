import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
  assertMappingValue,
} from "@lionden/testing";

const RECEIVERS = {
  publicMint: "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5",
  publicTransfer: "aleo1gnkqe9m4f5wdl3q904xsf6ed9kavj0e6fnggtwyt8v8apw05gy9syz34cz",
  privateMint: "aleo1q25acjdgqgvkeyxdhfm2jx00yt5m0eztsjesx7f063l7q975559qvdtjw7",
} as const;

async function deployToken() {
  const ctx = await setup();
  try {
    await ctx.deploy("token", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployToken);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("token program", () => {
  describe("mint_public", () => {
    it("mints tokens to a receiver", async () => {
      const receiver = RECEIVERS.publicMint;
      await ctx!.execute("token.aleo", "mint_public", [receiver, "1000u64"]);

      await assertMappingValue(
        ctx!.connection,
        "token.aleo",
        "balances",
        receiver,
        "1000u64",
      );
    });
  });

  describe("transfer_public", () => {
    it("transfers tokens between accounts", async () => {
      // Use account-0 as signer and a stable external receiver address.
      const sender = ctx!.accounts[0]!.address;
      const receiver = RECEIVERS.publicTransfer;

      // Mint initial tokens for sender
      await ctx!.execute("token.aleo", "mint_public", [sender, "2000u64"]);

      // Transfer some to receiver
      await ctx!.execute("token.aleo", "transfer_public", [receiver, "800u64"]);

      // Verify receiver got tokens
      await assertMappingValue(
        ctx!.connection,
        "token.aleo",
        "balances",
        receiver,
        "800u64",
      );
    });
  });

  describe("mint_private", () => {
    it("returns a token record", async () => {
      const receiver = RECEIVERS.privateMint;
      const result = await ctx!.execute("token.aleo", "mint_private", [
        receiver,
        "500u64",
      ], { mode: "local" });

      expect(result.outputs).toHaveLength(1);
    });
  });

  describe("advanceBlocks", () => {
    it("advances blocks on the devnode", async () => {
      const heightBefore = await ctx!.connection.getBlockHeight();
      await ctx!.advanceBlocks(3);
      const heightAfter = await ctx!.connection.getBlockHeight();

      expect(heightAfter).toBeGreaterThanOrEqual(heightBefore + 3);
    });
  });
});
