import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
  assertMappingValue,
} from "@lionden/testing";

async function deployAndCreateCollection() {
  const ctx = await setup();
  try {
    await ctx.deploy("nft_registry", { noCompile: true });

    // Create collection with id=1
    await ctx.execute("nft_registry.aleo", "create_collection", ["1u64"]);

    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployAndCreateCollection);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("nft_registry program", () => {
  describe("create_collection", () => {
    it("sets up collection admin and supply mappings", async () => {
      const admin = ctx!.accounts[0]!.address;

      await assertMappingValue(
        ctx!.connection,
        "nft_registry.aleo",
        "collection_admin",
        "1u64",
        admin,
      );

      await assertMappingValue(
        ctx!.connection,
        "nft_registry.aleo",
        "collection_supply",
        "1u64",
        "0u64",
      );
    });
  });

  describe("mint_nft", () => {
    const receiver =
      "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5";

    it("mints first NFT and increments supply", async () => {
      await ctx!.execute("nft_registry.aleo", "mint_nft", [
        receiver,
        "1u64",
        "1u64",
        "1field",
      ]);

      await assertMappingValue(
        ctx!.connection,
        "nft_registry.aleo",
        "collection_supply",
        "1u64",
        "1u64",
      );
    });

    it("mints second NFT", async () => {
      await ctx!.execute("nft_registry.aleo", "mint_nft", [
        receiver,
        "1u64",
        "2u64",
        "2field",
      ]);

      await assertMappingValue(
        ctx!.connection,
        "nft_registry.aleo",
        "collection_supply",
        "1u64",
        "2u64",
      );
    });
  });

  describe("mint_nft (local mode)", () => {
    it("produces record output locally without finalize", async () => {
      // Local execution of mint_nft — returns immediately, no finalize.
      // The Nft record output is produced locally (no txId).
      const receiver = ctx!.accounts[0]!.address;
      const result = await ctx!.execute(
        "nft_registry.aleo",
        "mint_nft",
        [receiver, "1u64", "99u64", "99field"],
        { mode: "local" },
      );

      // Local mode produces outputs but no transaction
      expect(result.outputs.length).toBeGreaterThan(0);
      expect(result.txId).toBeUndefined();

      // Supply should be unchanged — local mode doesn't run finalize
      await assertMappingValue(
        ctx!.connection,
        "nft_registry.aleo",
        "collection_supply",
        "1u64",
        "2u64",
      );
    });
  });
});
