// Leo constructor/upgrade compatibility smoke (port of Leo core upgrades/noupgrade).
// The @noupgrade constructor forbids any edition > 0, so once the program is on
// the network any upgrade is rejected. lionden does NO upgrade validation — the
// network/constructor enforces the rejection; this test only confirms the thin
// upgrade task surfaces that rejection as a thrown error.
//
// Test scope: deploy v1; swap to v2 fixture (adds a `subtract` transition);
// invoking `lre.tasks.run("upgrade")` must throw because the network rejects
// the upgrade transaction at confirmation.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNoupgradeExample } from "../typechain/NoupgradeExample.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function deployNoupgrade() {
  const ctx = await setup();
  try {
    await ctx.deploy("noupgrade_example", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployNoupgrade);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("noupgrade_example.aleo", () => {
  const noupgrade = createNoupgradeExample();

  beforeAll(() => {
    noupgrade.connect(ctx!.lre);
  });

  it("v1 deploy succeeded — main(2, 3) returns 5", async () => {
    expect(await noupgrade.main.locally(2, 3)).toBe(5);
  });

  it("upgrade attempt is rejected by @noupgrade constructor", async () => {
    const programPath = path.resolve(__dirname, "..", "programs", "noupgrade_example", "main.leo");
    const v2FixturePath = path.resolve(__dirname, "fixtures", "noupgrade_example_v2.leo");
    const v1Source = fs.readFileSync(programPath, "utf-8");

    try {
      fs.copyFileSync(v2FixturePath, programPath);

      // lionden has no upgrade preflight — the @noupgrade constructor rejects
      // the upgrade at confirmation, so the rejected tx surfaces as a thrown
      // DeployError.
      await expect(
        ctx!.lre.tasks.run("upgrade", { program: "noupgrade_example" }),
      ).rejects.toThrow();
    } finally {
      fs.writeFileSync(programPath, v1Source, "utf-8");
    }
  });
});
