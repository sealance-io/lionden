// Port of tmp/leo-examples/upgrades/noupgrade/. Demonstrates @noupgrade —
// constructor checks `assert_eq edition 0u16`, so once the program is on
// the network any subsequent deployment (edition > 0) is rejected.
//
// Test scope: deploy v1; swap to v2 fixture (adds a `sub` transition);
// invoking `lre.tasks.run("upgrade")` must throw because the network
// rejects the upgrade transaction.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
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
    expect(await noupgrade.main.locally({ a: 2, b: 3 })).toBe(5);
  });

  it("upgrade attempt is rejected by @noupgrade constructor", async () => {
    const programPath = path.resolve(
      __dirname,
      "..",
      "programs",
      "noupgrade_example",
      "main.leo",
    );
    const v2FixturePath = path.resolve(
      __dirname,
      "fixtures",
      "noupgrade_example_v2.leo",
    );
    const v1Source = fs.readFileSync(programPath, "utf-8");

    try {
      fs.copyFileSync(v2FixturePath, programPath);

      // The upgrade task should fail. Either preflight catches the
      // @noupgrade restriction locally, or the network rejects the
      // transaction at confirmation time. Both surface as a thrown error.
      await expect(
        ctx!.lre.tasks.run("upgrade", { program: "noupgrade_example" }),
      ).rejects.toThrow();
    } finally {
      fs.writeFileSync(programPath, v1Source, "utf-8");
    }
  });
});
