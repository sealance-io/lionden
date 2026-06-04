// Port of tmp/leo-examples/upgrades/admin/. @admin(address=...) restricts
// who may deploy or upgrade the program. Devnode account-0 is wired up
// as the admin via lionden.config.ts namedAccounts.
//
// Test scope: deploy v1 (admin signer), execute main; swap to v2 fixture
// (adds `subtract`), upgrade with admin signer, execute the new transition.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminExample } from "../typechain/AdminExample.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function deployAdmin() {
  const ctx = await setup();
  try {
    // The deploy task auto-detects the admin signer via namedAccounts.admin.
    await ctx.deploy("admin_example", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployAdmin);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("admin_example.aleo", () => {
  const admin = createAdminExample();

  beforeAll(() => {
    admin.connect(ctx!.lre);
  });

  it("v1 main(7, 5) returns 12", async () => {
    expect(await admin.main.locally({ a: 7, b: 5 })).toBe(12);
  });

  it("admin can upgrade and the new sub transition is callable", async () => {
    const programPath = path.resolve(__dirname, "..", "programs", "admin_example", "main.leo");
    const v2FixturePath = path.resolve(__dirname, "fixtures", "admin_example_v2.leo");
    const v1Source = fs.readFileSync(programPath, "utf-8");

    try {
      fs.copyFileSync(v2FixturePath, programPath);

      // namedAccounts.admin → ctx.accounts[0]; upgrade-task picks that as
      // the signer automatically when the program is @admin(...).
      await ctx!.lre.tasks.run("upgrade", { program: "admin_example" });

      // The v2-only `subtract` transition isn't on the typed wrapper class
      // loaded at suite startup (typechain reflects v1). Use the explicit
      // raw escape hatch for the post-upgrade ABI addition.
      const sub = await ctx!.raw.execute("admin_example.aleo", "subtract", ["10u32", "3u32"], {
        mode: "local",
      });
      expect(sub.outputs[0]).toBe("7u32");

      // Pre-existing transition still works after upgrade — typed wrapper OK.
      expect(await admin.main.locally({ a: 1, b: 2 })).toBe(3);
    } finally {
      fs.writeFileSync(programPath, v1Source, "utf-8");
    }
  });
});
