import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
  assertMappingValue,
  assertBalanceAtLeast,
  assertBlockHeightAtLeast,
} from "@lionden/testing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function deployCounter() {
  const ctx = await setup();
  try {
    await ctx.deploy("counter", { noCompile: true });
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
  const signer = () => ctx!.accounts[0]!.address;

  it("increments the counter", async () => {
    await ctx!.execute("counter.aleo", "increment", []);
    await ctx!.execute("counter.aleo", "increment", []);

    await assertMappingValue(
      ctx!.connection,
      "counter.aleo",
      "counters",
      signer(),
      "2u64",
    );
  });

  it("verifies account balance", async () => {
    await assertBalanceAtLeast(ctx!.connection, signer(), 0n);
  });

  it("verifies block height has advanced", async () => {
    await assertBlockHeightAtLeast(ctx!.connection, 1);
  });
});

describe("upgrade to v2", () => {
  const signer = () => ctx!.accounts[0]!.address;
  const programPath = path.resolve(
    __dirname,
    "..",
    "programs",
    "counter",
    "main.leo",
  );
  const v2FixturePath = path.resolve(__dirname, "fixtures", "counter_v2.leo");

  it("upgrades and tests new decrement transition", async () => {
    const v1Source = fs.readFileSync(programPath, "utf-8");

    try {
      // Swap in v2 source
      fs.copyFileSync(v2FixturePath, programPath);

      // Run upgrade — recompiles, checks ABI compat, broadcasts upgrade tx
      await ctx!.lre.tasks.run("upgrade", { program: "counter" });

      // Test new v2 transition
      await ctx!.execute("counter.aleo", "decrement", []);

      await assertMappingValue(
        ctx!.connection,
        "counter.aleo",
        "decrements",
        signer(),
        "1u64",
      );

      // Verify old mapping data survived the upgrade
      await assertMappingValue(
        ctx!.connection,
        "counter.aleo",
        "counters",
        signer(),
        "2u64",
      );

      // Verify old transition still works post-upgrade
      await ctx!.execute("counter.aleo", "increment", []);

      await assertMappingValue(
        ctx!.connection,
        "counter.aleo",
        "counters",
        signer(),
        "3u64",
      );
    } finally {
      // Always restore v1 source to avoid polluting the repo
      fs.writeFileSync(programPath, v1Source, "utf-8");
    }
  });
});
