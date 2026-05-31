import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
  assertMappingValue,
  assertBalanceAtLeast,
  assertBlockHeightAtLeast,
} from "@lionden/testing";
import { createCounter } from "../typechain/Counter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function deployCounter() {
  const ctx = await setup();
  try {
    await ctx.deploy(createCounter(), { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployCounter);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("counter v1", () => {
  const counter = createCounter();
  const signer = () => ctx!.accounts[0]!;

  beforeAll(() => {
    counter.connect(ctx!.lre);
  });

  it("increments the counter", async () => {
    await counter.increment.accepted();
    await counter.increment.accepted();

    expect(await counter.mappings.counters.get(signer())).toBe(2n);
  });

  it("verifies account balance", async () => {
    await assertBalanceAtLeast(ctx!.connection, signer().address, 0n);
  });

  it("verifies block height has advanced", async () => {
    await assertBlockHeightAtLeast(ctx!.connection, 1);
  });
});

describe("upgrade to v2", () => {
  const counter = createCounter();
  const signer = () => ctx!.accounts[0]!;
  const programPath = path.resolve(
    __dirname,
    "..",
    "programs",
    "counter",
    "main.leo",
  );
  const v2FixturePath = path.resolve(__dirname, "fixtures", "counter_v2.leo");

  beforeAll(() => {
    counter.connect(ctx!.lre);
  });

  it("upgrades and tests new decrement transition", async () => {
    const v1Source = fs.readFileSync(programPath, "utf-8");

    try {
      // Swap in v2 source
      fs.copyFileSync(v2FixturePath, programPath);

      // Run upgrade — recompiles, checks ABI compat, broadcasts upgrade tx
      await ctx!.lre.tasks.run("upgrade", { program: "counter" });

      // The v2 transition `decrement` and v2 mapping `decrements` are absent
      // from the typechain class loaded by this test process (compiled from
      // v1 source at suite startup). Use the explicit raw escape hatch for those
      // post-upgrade ABI additions; v1 calls keep using the typed wrapper.
      await ctx!.raw.execute(counter.programId, "decrement", []);

      await assertMappingValue(
        ctx!.connection,
        counter.programId,
        "decrements",
        signer().address,
        "1u64",
      );

      // Old v1 mapping survived the upgrade
      expect(await counter.mappings.counters.get(signer())).toBe(2n);

      // Old v1 transition still works post-upgrade
      await counter.increment.accepted();

      expect(await counter.mappings.counters.get(signer())).toBe(3n);
    } finally {
      // Always restore v1 source to avoid polluting the repo
      fs.writeFileSync(programPath, v1Source, "utf-8");
    }
  });
});
