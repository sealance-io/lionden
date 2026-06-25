/**
 * Phase 2 — compilation + codegen coverage (in-process, no devnode).
 *
 * For each lane project: adapt → drive the real `compile` task (network deps
 * pre-seeded from the vendored snapshot, so it stays hermetic) → assert ABI
 * invariants against the parsed `ProgramABI` and that a full importable
 * `typechain/` was emitted (BaseContract + per-program wrappers + barrel
 * `index.ts`). Runs every project in one process and credits coverage to
 * `packages/leo-compiler` + `packages/plugin-leo`.
 *
 * Generated projects are written under `generated/` (gitignored) so the emitted
 * `typechain/` persists for the on-chain suites to import.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createLre } from "@lionden/core";
import { type ProgramABI, parseAbi, resolveContractClassName } from "@lionden/leo-compiler";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginTest from "@lionden/plugin-test";
import { describe, expect, it } from "vitest";
import { type AdaptedProject, adaptSampleGroup, DEFAULT_UPSTREAM_ROOT } from "./adapter/adapt.js";
import { getSpec, LANE_PROJECTS } from "./adapter/specs.js";
import { makeResolvedConfig, seedNetworkDepCache, upstreamReady } from "./adapter/test-support.js";

const ready = upstreamReady(DEFAULT_UPSTREAM_ROOT);
const PLUGINS = [pluginLeo, pluginNetwork, pluginDeploy, pluginTest];
const GAPFILLER_DIR = fileURLToPath(new URL("./gapfiller", import.meta.url));

/** Mirrors plugin-leo's `programIdToClassName` (the emitted wrapper file name). */
function programIdToClassName(programId: string): string {
  return programId
    .replace(/\.aleo$/, "")
    .split(/[_\-.]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

async function compileProject(
  name: string,
  opts: { codegen?: boolean } = {},
): Promise<{ project: AdaptedProject; abis: ProgramABI[] }> {
  const project = await adaptSampleGroup(getSpec(name));
  const config = makeResolvedConfig(project.projectDir, project.programsDir, {
    codegen: { enabled: opts.codegen ?? true, outDir: "typechain", dynamicRecords: {} },
  });
  seedNetworkDepCache(config, project.manifest.networkDeps);
  const lre = createLre({ config, plugins: PLUGINS });
  await lre.tasks.run("compile", {});

  const abis = project.manifest.units
    .filter((u) => u.kind === "program")
    .map((u) => {
      const abiPath = path.join(config.paths.artifacts, u.id, "abi.json");
      expect(fs.existsSync(abiPath), `missing ABI for ${u.id}`).toBe(true);
      return parseAbi(fs.readFileSync(abiPath, "utf-8"));
    });
  return { project, abis };
}

/** Compile a hand-authored (non-adapted) project in place; return its ABIs. */
async function compileHandAuthored(
  projectDir: string,
  programIds: string[],
): Promise<ProgramABI[]> {
  const config = makeResolvedConfig(projectDir, path.join(projectDir, "programs"), {
    codegen: { enabled: true, outDir: "typechain", dynamicRecords: {} },
  });
  const lre = createLre({ config, plugins: PLUGINS });
  await lre.tasks.run("compile", {});
  return programIds.map((id) => {
    const abiPath = path.join(config.paths.artifacts, id, "abi.json");
    expect(fs.existsSync(abiPath), `missing ABI for ${id}`).toBe(true);
    return parseAbi(fs.readFileSync(abiPath, "utf-8"));
  });
}

function assertTypechainEmittedAt(typechainDir: string, abis: ProgramABI[]): void {
  expect(fs.existsSync(path.join(typechainDir, "BaseContract.ts"))).toBe(true);
  const index = fs.readFileSync(path.join(typechainDir, "index.ts"), "utf-8");
  expect(index).toContain('export * from "./BaseContract.js";');
  for (const abi of abis) {
    const fileName = programIdToClassName(abi.program);
    const className = resolveContractClassName(abi);
    const wrapperPath = path.join(typechainDir, `${fileName}.ts`);
    expect(fs.existsSync(wrapperPath), `missing wrapper ${fileName}.ts`).toBe(true);
    const wrapper = fs.readFileSync(wrapperPath, "utf-8");
    expect(wrapper).toContain(`export class ${className}`);
    expect(wrapper).toContain(`export function create${className}`);
    expect(index).toContain(`create${className}`);
  }
}

function assertTypechainEmitted(project: AdaptedProject, abis: ProgramABI[]): void {
  assertTypechainEmittedAt(path.join(project.projectDir, "typechain"), abis);
}

describe.skipIf(!ready)("compile + codegen coverage", () => {
  it("adapts every lane project (external_composition is excluded)", () => {
    expect(LANE_PROJECTS.map((s) => s.name)).toEqual([
      "abi_surface",
      "native_runtime_edges",
      "dynamic_dispatch",
      "upgradability",
    ]);
  });

  it("abi_surface — full ABI breadth + view optionals", async () => {
    // abi_surface is compile-only: codegen rejects its binding (see the finding
    // lock below), so compile with codegen disabled to exercise the ABI breadth
    // itself — the ABI is emitted by the compiler independently of codegen.
    const { abis } = await compileProject("abi_surface", { codegen: false });
    const [abi] = abis;
    expect(abi.program).toBe("abi_surface.aleo");
    expect(abi.structs.length).toBeGreaterThan(0);
    expect(abi.records.length).toBeGreaterThan(0);
    expect(abi.mappings.length).toBeGreaterThan(0);
    expect(abi.storage_variables.length).toBeGreaterThan(0);
    expect(abi.transitions.length).toBeGreaterThan(0);
    expect(abi.views?.length ?? 0).toBeGreaterThan(0);
    // No assertTypechainEmitted: codegen can't emit a binding for this program.
  });

  // LOCKS the abi_surface compile-only codegen finding (see specs.ts).
  // Originally this locked a const-generic struct `Slot::[N]` being emitted
  // verbatim as an invalid TypeScript type identifier. Codegen now rejects
  // `Primitive::Signature` EARLIER — in assertCodegenSupportedTypes, before any
  // binding is emitted (typescript-generator.ts) — so that const-generic gap is
  // now masked behind this stricter primitive check. abi_surface therefore
  // stays compile-only and cannot have an on-chain suite that imports its
  // binding (hence `compileOnly`). If Signature support lands in codegen, this
  // assertion flips: re-lock the (then-resurfaced) `Slot::[N]` const-generic
  // finding and re-evaluate promoting abi_surface to the on-chain set.
  it("abi_surface — codegen rejects the binding (compile-only finding)", async () => {
    expect(getSpec("abi_surface").compileOnly).toBe(true);
    await expect(compileProject("abi_surface", { codegen: true })).rejects.toThrow(
      /Primitive::Signature is not supported/,
    );
  });

  it("native_runtime_edges — diamond import of credits.aleo + native records", async () => {
    const { project, abis } = await compileProject("native_runtime_edges");
    expect(project.manifest.networkDeps).toContain("credits.aleo");
    const nre = abis.find((a) => a.program === "native_runtime_edges.aleo")!;
    expect(nre.transitions.length).toBeGreaterThan(0);
    // It references credits.aleo + both credit_left/right siblings (diamond).
    const raw = fs.readFileSync(
      path.join(project.projectDir, "artifacts", "native_runtime_edges.aleo", "main.aleo"),
      "utf-8",
    );
    expect(raw).toContain("credits.aleo");
    assertTypechainEmitted(project, abis);
  });

  it("dynamic_dispatch — DynamicRecord + interface implements", async () => {
    const { project, abis } = await compileProject("dynamic_dispatch");
    const dispatcher = abis.find((a) => a.program === "dispatcher.aleo")!;
    const dispatcherAbiRaw = fs.readFileSync(
      path.join(project.projectDir, "artifacts", "dispatcher.aleo", "abi.json"),
      "utf-8",
    );
    expect(dispatcherAbiRaw).toContain("DynamicRecord");
    expect(dispatcher.transitions.length).toBeGreaterThan(0);
    const tokenAlt = abis.find((a) => a.program === "token_alt.aleo")!;
    expect(tokenAlt.implements?.length ?? 0).toBeGreaterThan(0);
    assertTypechainEmitted(project, abis);
  });

  it("upgradability — six programs compile; constructor stays out of the ABI", async () => {
    const { project, abis } = await compileProject("upgradability");
    expect(abis.map((a) => a.program).sort()).toEqual([
      "admin_upgrade.aleo",
      "checksum_upgrade.aleo",
      "frozen_base.aleo",
      "governance.aleo",
      "open_upgrade.aleo",
      "timelock_upgrade.aleo",
    ]);
    for (const abi of abis) {
      // Constructor policy lives in bytecode + manifest, never the ABI.
      expect(abi.transitions.some((t) => t.name === "constructor")).toBe(false);
    }
    assertTypechainEmitted(project, abis);
  });

  // The gap-filler is hand-authored (committed), not adapted — but it compiles
  // and codegens through the same path, so verify it here too.
  it("lionden_gapfiller — primitive serializers + hashing + private outputs", async () => {
    const [abi] = await compileHandAuthored(GAPFILLER_DIR, ["lionden_gapfiller.aleo"]);
    expect(abi.program).toBe("lionden_gapfiller.aleo");
    const names = new Set(abi.transitions.map((t) => t.name));
    // 5 named primitives + u8..u128 + i8..i128 echoes.
    for (const p of ["echo_addr", "echo_field", "echo_group", "echo_scalar", "echo_bool"]) {
      expect(names.has(p), `missing ${p}`).toBe(true);
    }
    for (const w of [8, 16, 32, 64, 128]) {
      expect(names.has(`echo_u${w}`) && names.has(`echo_i${w}`), `missing echo_*${w}`).toBe(true);
    }
    for (const h of ["hash_bhp", "hash_poseidon", "hash_pedersen"]) {
      expect(names.has(h), `missing ${h}`).toBe(true);
    }
    expect(names.has("mint_secret")).toBe(true);
    // Private record output → a record in the ABI for the decryption surface.
    expect(abi.records.some((r) => /SecretNote/.test(JSON.stringify(r)))).toBe(true);
    assertTypechainEmittedAt(path.join(GAPFILLER_DIR, "typechain"), [abi]);
  });
});
