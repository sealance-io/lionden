import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
} from "@lionden/testing";
import { createNftRegistry } from "../typechain/NftRegistry.js";

const nft = createNftRegistry();

async function deployAndCreateCollection() {
  const ctx = await setup();
  try {
    await ctx.deploy("nft_registry", { noCompile: true });

    nft.connect(ctx.lre);

    // Create collection with id=1
    await nft.create_collectionBroadcast(1n);

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
  // Re-bind the LRE in case loadFixture restored from a different context.
  nft.connect(ctx.lre);
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

      expect(await nft.getCollection_admin(1n)).toBe(admin);
      expect(await nft.getCollection_supply(1n)).toBe(0n);
    });
  });

  describe("mint_nft", () => {
    const receiver =
      "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5";

    it("mints first NFT and increments supply", async () => {
      await nft.mint_nftBroadcast(receiver, 1n, 1n, "1field");

      expect(await nft.getCollection_supply(1n)).toBe(1n);
    });

    it("mints second NFT", async () => {
      await nft.mint_nftBroadcast(receiver, 1n, 2n, "2field");

      expect(await nft.getCollection_supply(1n)).toBe(2n);
    });
  });

  describe("mint_nft (local mode)", () => {
    it("produces typed Nft record locally without finalize", async () => {
      // Local execution of mint_nft — returns immediately, no finalize.
      // The typed wrapper deserializes the Nft record output.
      const receiver = ctx!.accounts[0]!.address;
      const [record] = await nft.mint_nft(receiver, 1n, 99n, "99field");

      // Address comes back with a `.private` visibility suffix on record
      // outputs (typechain's address deserializer doesn't strip it).
      expect(record.owner.startsWith(receiver)).toBe(true);
      expect(record.metadata.collection_id).toBe(1n);
      expect(record.metadata.serial).toBe(99n);

      // Supply should be unchanged — local mode doesn't run finalize
      expect(await nft.getCollection_supply(1n)).toBe(2n);
    });
  });
});
