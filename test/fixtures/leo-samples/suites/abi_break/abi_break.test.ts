// COMMITTED authored suite. The adapter copies it into
// generated/abi_break/test/ (generated projects are gitignored, so authored
// tests cannot live inside them). Runtime green requires a devnode; the lane
// runs it via `lionden test` (sequential, no proving). Typechecked against the
// generated bindings.
//
// Proves the end-to-end ABI-compat REJECT path that the `upgradability` group
// can't reach (all its v1→v2 pairs are ABI-identical version bumps):
//
//   deploy abi_break v1 (version() -> u8, @custom always-allow)
//   → swap the breaking v2 in place (version() -> u32)
//   → run the `upgrade` task
//   → UpgradeCompatibilityError ("not ABI-compatible", transition_modified)
//
// The @custom constructor accepts every upgrade, and its body is byte-identical
// across v1/v2 (constructor immutability holds), so the ONLY reason the upgrade
// is refused is the abi-compat preflight (`checkAbiCompatible` →
// `UpgradeCompatibilityError`). Exhaustive comparator-branch coverage lives in
// packages/plugin-deploy/src/abi-compat.test.ts; this lane proves the integration
// reject path once.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAbiBreak } from "../typechain/AbiBreak.js";

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
 * source, overwriting `artifacts/<programId>/`; restoring only the source would
 * leave v2 bytecode behind. Mirrors the upgradability suite's helper.
 */
async function withV2Swapped<T>(programId: string, fn: () => Promise<T>): Promise<T> {
  const entry = v2Entry(programId);
  const targetEntry = path.join(entry.targetUnitDir, "main.leo");
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

let ctx: TestContext | undefined;

beforeAll(async () => {
  ctx = await loadFixture(async () => setup());
});

afterAll(async () => {
  if (ctx) await ctx.teardown();
  else clearFixtures();
});

describe("abi_break — ABI-incompatible upgrade is rejected", () => {
  it("deploys abi_break v1 (version() is 1u8 locally)", async () => {
    await ctx!.deploy("abi_break", { noCompile: true });
    const prog = createAbiBreak();
    prog.connect(ctx!.lre);
    expect(await prog.version.locally()).toBe(1);
  });

  it("rejects the v2 upgrade with UpgradeCompatibilityError (transition_modified)", async () => {
    await withV2Swapped("abi_break.aleo", async () => {
      // v2 changes version()'s output type u8 → u32 — an ABI-breaking transition
      // signature change. The @custom policy would accept; the upgrade is refused
      // solely by the abi-compat preflight.
      let caught: unknown;
      try {
        await ctx!.lre.tasks.run("upgrade", { program: "abi_break", network: ctx!.network });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toMatch(/not ABI-compatible/);
      expect(message).toMatch(/transition_modified/);
    });
  });
});
