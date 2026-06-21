import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import type { NetworkManager } from "@lionden/network";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageVectorProbe } from "../typechain/index.js";
import { Leo, StorageValueNotFoundError } from "../typechain/BaseContract.js";

const PROGRAM_ID = "storage_vector_probe.aleo";
const FIRST_FIELD = Leo.field(101);
const SECOND_FIELD = Leo.field(202);

async function deploySeededProbe() {
  const ctx = await setup({ skipDevnode: true });
  try {
    await ctx.deploy("storage_vector_probe", { noCompile: true });
    const contract = createStorageVectorProbe().connect(ctx.lre);
    await contract.seed.accepted({
      owner: Leo.address(ctx.accounts[0]!.address),
      first: FIRST_FIELD,
      second: SECOND_FIELD,
    });
    return { ctx, contract };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;
let contract: ReturnType<typeof createStorageVectorProbe> | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deploySeededProbe);
  ctx = fixture.ctx;
  contract = fixture.contract;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("storage vectors vs mapping arrays", () => {
  it("raw devnode mappings expose singleton storage and lowered vector entries", async () => {
    const network = ctx!.lre.network as NetworkManager;
    const admin = ctx!.accounts[0]!.address;

    await expect(network.getMappingValue(PROGRAM_ID, "admin__", "false")).resolves.toBe(admin);
    await expect(
      network.getMappingValue(PROGRAM_ID, "field_history__len__", "false"),
    ).resolves.toBe("2u32");
    await expect(network.getMappingValue(PROGRAM_ID, "field_history__", "0u32")).resolves.toBe(
      FIRST_FIELD,
    );
    await expect(network.getMappingValue(PROGRAM_ID, "field_history__", "1u32")).resolves.toBe(
      SECOND_FIELD,
    );
  });

  it("Leo can read the vector slots after seeding", async () => {
    await expect(
      contract!.assert_vector_slot.accepted({ index: 0, expected: FIRST_FIELD }),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      contract!.assert_vector_slot.accepted({ index: 1, expected: SECOND_FIELD }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("generated singleton storage accessor reads lowered singleton storage", async () => {
    await expect(contract!.storage.admin.get()).resolves.toBe(ctx!.accounts[0]!.address);
  });

  it("generated vector storage accessor misses lowered vector storage", async () => {
    await expect(contract!.storage.fieldHistory.tryGet()).resolves.toBeNull();
    await expect(contract!.storage.fieldHistory.get()).rejects.toBeInstanceOf(
      StorageValueNotFoundError,
    );
  });

  it("generated mapping accessor reads fixed array values normally", async () => {
    await expect(contract!.mappings.fixedRows.contains(true)).resolves.toBe(true);
    await expect(contract!.mappings.fixedRows.get(true)).resolves.toEqual([1, 2, 3]);
    await expect(contract!.mappings.fixedRows.tryGet(true)).resolves.toEqual([1, 2, 3]);
    await expect(contract!.mappings.fixedRows.getOrUse(true, [9, 9, 9])).resolves.toEqual([
      1, 2, 3,
    ]);

    await expect(contract!.mappings.fixedRows.contains(false)).resolves.toBe(false);
    await expect(contract!.mappings.fixedRows.tryGet(false)).resolves.toBeNull();
    await expect(contract!.mappings.fixedRows.getOrUse(false, [9, 9, 9])).resolves.toEqual([
      9, 9, 9,
    ]);
  });
});
