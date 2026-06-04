// Port of tmp/leo-examples/upgrades/timelock/. @custom constructor that
// only allows upgrades once block.height crosses a threshold.
//
// Test scope (positive case):
//   1. Deploy v1 (succeeds at any height — edition 0 skips the assert)
//   2. advanceBlocks past the threshold
//   3. Swap to v2 fixture and upgrade — succeeds
//   4. The new transition is callable after upgrade
//
// We deliberately skip the negative case (upgrade attempt at low height
// should fail). Reproducing that reliably is hard: with autoBlock on the
// devnode keeps producing blocks, so by the time the rejected tx lands
// the height may already be over threshold; with autoBlock off the
// upgrade can never land at all. The positive flow alone exercises both
// the @custom constructor codegen and `advanceBlocks` plumbing, which
// is the parity-relevant logic. Negative-case testing belongs in
// constructor unit tests within plugin-deploy.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTimelockExample } from "../typechain/TimelockExample.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIMELOCK_THRESHOLD = 30;

async function deployTimelock() {
  const ctx = await setup();
  try {
    await ctx.deploy("timelock_example", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployTimelock);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

async function currentBlockHeight(c: TestContext): Promise<number> {
  const conn = c.connection as unknown as {
    networkId: string;
    endpoint: string;
  };
  const response = await fetch(`${conn.endpoint}/${conn.networkId}/block/height/latest`);
  const text = await response.text();
  return Number(text.trim());
}

describe("timelock_example.aleo", () => {
  const timelock = createTimelockExample();

  beforeAll(() => {
    timelock.connect(ctx!.lre);
  });

  it("v1 deploy succeeded — main(2, 3) returns 5", async () => {
    expect(await timelock.main.locally({ a: 2, b: 3 })).toBe(5);
  });

  it("upgrade succeeds once block.height crosses the threshold", async () => {
    const programPath = path.resolve(__dirname, "..", "programs", "timelock_example", "main.leo");
    const v2FixturePath = path.resolve(__dirname, "fixtures", "timelock_example_v2.leo");
    const v1Source = fs.readFileSync(programPath, "utf-8");

    try {
      const heightNow = await currentBlockHeight(ctx!);
      const blocksToAdvance = TIMELOCK_THRESHOLD - heightNow + 5;
      if (blocksToAdvance > 0) {
        await ctx!.advanceBlocks(blocksToAdvance);
      }
      const heightAfter = await currentBlockHeight(ctx!);
      expect(heightAfter).toBeGreaterThanOrEqual(TIMELOCK_THRESHOLD);

      fs.copyFileSync(v2FixturePath, programPath);
      await ctx!.lre.tasks.run("upgrade", { program: "timelock_example" });

      // The v2-only `subtract` transition isn't on the typed wrapper class
      // loaded at suite startup (typechain reflects v1). Use the explicit
      // raw escape hatch for the post-upgrade ABI addition.
      const sub = await ctx!.raw.execute("timelock_example.aleo", "subtract", ["10u32", "3u32"], {
        mode: "local",
      });
      expect(sub.outputs[0]).toBe("7u32");
    } finally {
      fs.writeFileSync(programPath, v1Source, "utf-8");
    }
  });
});
