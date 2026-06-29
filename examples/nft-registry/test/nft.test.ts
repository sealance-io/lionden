import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Leo } from "../typechain/BaseContract.js";
import { createNftRegistry } from "../typechain/NftRegistry.js";

const nft = createNftRegistry();

async function deployAndCreateCollection() {
  const ctx = await setup();
  try {
    await ctx.deploy(nft, { noCompile: true });

    nft.connect(ctx.lre);

    // Create collection with id=1
    await nft.create_collection.accepted({ arg0: 1n });

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

      expect(await nft.mappings.collectionAdmin.get(1n)).toBe(admin);
      expect(await nft.mappings.collectionSupply.get(1n)).toBe(0n);
    });
  });

  describe("mint_nft", () => {
    const receiver = "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5";

    it("mints first NFT and increments supply", async () => {
      await nft.mint_nft.accepted({
        arg0: Leo.address(receiver),
        arg1: 1n,
        arg2: 1n,
        arg3: 1n,
      });

      expect(await nft.mappings.collectionSupply.get(1n)).toBe(1n);
    });

    it("mints second NFT", async () => {
      await nft.mint_nft.accepted({
        arg0: Leo.address(receiver),
        arg1: 1n,
        arg2: 2n,
        arg3: 2n,
      });

      expect(await nft.mappings.collectionSupply.get(1n)).toBe(2n);
    });
  });

  describe("mint_nft (local mode)", () => {
    it("produces typed Nft record locally without finalize", async () => {
      // Local execution of mint_nft — returns immediately, no finalize.
      // The typed wrapper deserializes the Nft record output.
      const receiver = ctx!.accounts[0]!;
      const [record] = await nft.mint_nft.locally({
        arg0: receiver,
        arg1: 1n,
        arg2: 99n,
        arg3: 99n,
      });

      expect(record.owner).toBe(receiver.address);
      expect(record.metadata.collection_id).toBe(1n);
      expect(record.metadata.serial).toBe(99n);

      // Supply should be unchanged — local mode doesn't run finalize
      expect(await nft.mappings.collectionSupply.get(1n)).toBe(2n);
    });
  });
});
