// COMMITTED authored suite. The adapter copies it into
// generated/upgradability/test/ (generated projects are gitignored, so authored
// tests cannot live inside them). Runtime green requires a devnode; the lane
// runs it via `lionden test` (sequential, no proving). Typechecked against the
// generated bindings.
//
// Drives the constructor-policy upgrade matrix (deploy v1 → in-place swap v2 →
// run the `upgrade` task) against the generated bindings + deploy task:
//   @noupgrade (frozen_base)   → upgrade REJECTED (edition assert)
//   @custom    (open_upgrade)  → upgrade ACCEPTED, version() lowers to 2
//   @custom    (timelock)      → upgrade ACCEPTED on the devnode (height ≥ 15)
//   @admin     (admin_upgrade) → upgrade ACCEPTED with the admin (genesis) key
//   @checksum  (checksum)      → upgrade REJECTED before governance approval
//
// The v1→v2 swap is in place: v1 and v2 share a program id, so the upgrade task
// (which recompiles from config.paths.programs) needs the v2 source physically
// replacing v1 first. The swap is read from the adapter's dependency-manifest
// and always restored in `finally` (plan 0d).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFrozenBase } from "../typechain/FrozenBase.js";
import { createOpenUpgrade } from "../typechain/OpenUpgrade.js";

interface V2Entry {
  readonly programId: string;
  readonly v2SourcePath: string;
  readonly targetUnitDir: string;
}

const MANIFEST_PATH = fileURLToPath(new URL("../dependency-manifest.json", import.meta.url));

function v2Entry(programId: string): V2Entry {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as { v2?: V2Entry[] };
  const entry = manifest.v2?.find((e) => e.programId === programId);
  if (!entry) throw new Error(`No v2 manifest entry for ${programId}`);
  return entry;
}

/**
 * Swap the v2 source over v1, run `fn`, then always restore BOTH the v1 source
 * and the v1 compiled artifacts. The upgrade task recompiles from the swapped
 * source (step 6 of upgrade-task.ts), overwriting `artifacts/<programId>/` — the
 * `.aleo` the LRE runs for `.locally()`. Restoring only the source would leave
 * v2 bytecode behind and break a later v1 read-back (e.g. frozen_base's version
 * smoke after its rejected upgrade).
 */
async function withV2Swapped<T>(programId: string, fn: () => Promise<T>): Promise<T> {
  const entry = v2Entry(programId);
  const targetEntry = path.join(entry.targetUnitDir, "main.leo");
  // targetUnitDir = <projectDir>/programs/<base>; artifacts live at
  // <projectDir>/artifacts/<programId>.
  const projectDir = path.dirname(path.dirname(entry.targetUnitDir));
  const artifactsDir = path.join(projectDir, "artifacts", programId);
  const artifactsBak = `${artifactsDir}.v1bak`;

  const v1Source = fs.readFileSync(targetEntry, "utf-8");
  const hadArtifacts = fs.existsSync(artifactsDir);
  if (hadArtifacts) {
    fs.rmSync(artifactsBak, { recursive: true, force: true });
    fs.cpSync(artifactsDir, artifactsBak, { recursive: true });
  }
  fs.copyFileSync(entry.v2SourcePath, targetEntry);
  try {
    return await fn();
  } finally {
    fs.writeFileSync(targetEntry, v1Source);
    if (hadArtifacts) {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
      fs.cpSync(artifactsBak, artifactsDir, { recursive: true });
      fs.rmSync(artifactsBak, { recursive: true, force: true });
    }
  }
}

/** Run the upgrade task for a program; returns the new edition on success. */
async function runUpgrade(c: TestContext, program: string): Promise<number> {
  const result = (await c.lre.tasks.run("upgrade", { program, network: c.network })) as {
    newEdition: number;
  };
  return result.newEdition;
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  ctx = await loadFixture(async () => setup());
});

afterAll(async () => {
  if (ctx) await ctx.teardown();
  else clearFixtures();
});

describe("upgradability — @noupgrade is frozen", () => {
  it("frozen_base deploys at edition 0 but rejects the v2 upgrade", async () => {
    await ctx!.deploy("frozen_base", { noCompile: true });
    await withV2Swapped("frozen_base.aleo", async () => {
      // @noupgrade lowers to `assert.eq edition 0u16`; edition becomes 1 on
      // upgrade, so the constructor rejects.
      await expect(runUpgrade(ctx!, "frozen_base")).rejects.toThrow();
    });
  });
});

describe("upgradability — @custom always-allow accepts", () => {
  it("open_upgrade upgrades to edition 1 and version() lowers to 2", async () => {
    await ctx!.deploy("open_upgrade", { noCompile: true });
    await withV2Swapped("open_upgrade.aleo", async () => {
      const edition = await runUpgrade(ctx!, "open_upgrade");
      expect(edition).toBe(1);
      // With the v2 source compiled in place, the upgraded program's version()
      // returns 2 (v1 returned 1).
      const open = createOpenUpgrade();
      open.connect(ctx!.lre);
      expect(await open.version.locally()).toBe(2);
    });
  });
});

describe("upgradability — @custom timelock accepts past the height bound", () => {
  it("timelock_upgrade upgrades (devnode height ≥ 15)", async () => {
    await ctx!.deploy("timelock_upgrade", { noCompile: true });
    await withV2Swapped("timelock_upgrade.aleo", async () => {
      const edition = await runUpgrade(ctx!, "timelock_upgrade");
      expect(edition).toBe(1);
    });
  });
});

describe("upgradability — @admin key-gated", () => {
  it("admin_upgrade upgrades with the admin (genesis) key", async () => {
    // The @admin address baked into admin_upgrade is the devnode genesis
    // address (== accounts[0]), which is also the default deploy/upgrade signer,
    // so the upgrade is accepted without extra key wiring. The generated config
    // declares `namedAccounts.admin: { default: 0 }`, so the resolved admin role
    // is the signable genesis key — assert that wiring resolves (exercises the
    // named-account resolution path the upgrade task reads).
    const admin = ctx!.named.signer("admin");
    expect(admin.privateKey).toBe(ctx!.accounts[0]!.privateKey);
    expect(admin.address).toBe(ctx!.accounts[0]!.address);
    await ctx!.deploy("admin_upgrade", { noCompile: true });
    await withV2Swapped("admin_upgrade.aleo", async () => {
      const edition = await runUpgrade(ctx!, "admin_upgrade");
      expect(edition).toBe(1);
    });
  });

  // Wrong-key reject — the per-upgrade signer override (`UpgradeOptions.signerKey`)
  // lets the suite drive the upgrade with a non-admin devnode key. lionden now
  // wires `validateAdminSigner` into `runUpgradePreflight`, so the mismatch is
  // rejected locally (fail-fast) before any broadcast, rather than being signed
  // and rejected on-chain by the @admin constructor.
  it("admin_upgrade rejects an upgrade signed by a non-admin key", async () => {
    await ctx!.deploy("admin_upgrade", { noCompile: true });
    const nonAdminKey = ctx!.accounts[1]!.privateKey;
    await withV2Swapped("admin_upgrade.aleo", async () => {
      await expect(
        ctx!.lre.tasks.run("upgrade", {
          program: "admin_upgrade",
          network: ctx!.network,
          signerKey: nonAdminKey,
        }),
      ).rejects.toThrow(/Only the admin address can upgrade/);
    });
  });
});

describe("upgradability — @checksum governance-gated", () => {
  it("checksum_upgrade rejects the v2 upgrade before governance approval", async () => {
    // Deploying checksum_upgrade auto-deploys its governance.aleo dependency.
    // The @checksum constructor reads governance.aleo/approved_checksum[true];
    // it is unset, so the upgrade rejects.
    await ctx!.deploy("checksum_upgrade", { noCompile: true });
    await withV2Swapped("checksum_upgrade.aleo", async () => {
      await expect(runUpgrade(ctx!, "checksum_upgrade")).rejects.toThrow();
    });
  });

  // LIONDEN API GAP — no pre-broadcast v2-checksum accessor.
  // The accepted path needs the compiled v2 program checksum so the suite can
  // call `governance.aleo::approve(<checksum>)` BEFORE the upgrade is broadcast.
  // The upgrade task (packages/plugin-deploy) computes the v2 checksum
  // internally but does not surface it pre-broadcast, and there is no task that
  // compiles-and-reports the checksum without broadcasting (upstream captures it
  // via `leo upgrade --save` then reads `deployment.program_checksum`). The fix
  // is a pre-broadcast checksum accessor (e.g. an upgrade `dryRun`/`--save` mode
  // that returns the v2 checksum). Until then `governance.aleo::approve` is never
  // exercised at runtime and the @checksum *accept* side is unproven (only the
  // reject-before-approval path runs). See the lane README "Known lionden gaps
  // surfaced by this lane".
  it.skip("checksum_upgrade accepts after governance.approve(<v2 checksum>)", () => {});
});

// Keep the frozen-base binding import referenced (version read-back smoke for the
// deployed v1) so the wrapper is exercised even though the upgrade is rejected.
describe("upgradability — deployed v1 binding smoke", () => {
  it("frozen_base v1 version() is 1 locally", async () => {
    const frozen = createFrozenBase();
    frozen.connect(ctx!.lre);
    expect(await frozen.version.locally()).toBe(1);
  });
});
