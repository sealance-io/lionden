import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DiscoveredUnit,
  discoverUnits,
  extractProgramId,
  resolveDependencies,
  unitId,
} from "@lionden/leo-compiler";
import type { SampleGroupSpec } from "./specs.js";
import { renderConfig, renderPackageJson, renderTsconfig } from "./templates.js";

// ---------------------------------------------------------------------------
// Default layout (relative to this module: test/fixtures/leo-samples/adapter/)
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = path.resolve(HERE, "..");
export const DEFAULT_UPSTREAM_ROOT = path.join(FIXTURES_ROOT, ".upstream");
export const DEFAULT_OUTPUT_ROOT = path.join(FIXTURES_ROOT, "generated");
export const DEFAULT_SUITES_ROOT = path.join(FIXTURES_ROOT, "suites");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AdaptedUnit {
  readonly id: string;
  readonly kind: "program" | "library";
  /** Subdir under `programs/`. */
  readonly dir: string;
}

export interface V2Entry {
  readonly programId: string;
  /** Absolute path to the adapted v2 `main.leo` (under `programs.v2/`). */
  readonly v2SourcePath: string;
  /** `programs/<dir>` the v2 source replaces during an in-place upgrade swap. */
  readonly targetUnitDir: string;
}

export interface DependencyManifest {
  readonly project: string;
  readonly units: readonly AdaptedUnit[];
  readonly topoOrder: readonly string[];
  readonly imports: Readonly<Record<string, readonly string[]>>;
  readonly networkDeps: readonly string[];
  /** Per source file (relative to `programs/`): library deps reconciled into it. */
  readonly rewrites: Readonly<Record<string, readonly string[]>>;
  readonly executionImports?: Readonly<Record<string, readonly string[]>>;
  readonly v2?: readonly V2Entry[];
}

export interface AdaptedProject {
  readonly name: string;
  readonly projectDir: string;
  readonly programsDir: string;
  readonly configPath: string;
  readonly manifestPath: string;
  readonly manifest: DependencyManifest;
  readonly testDir: string;
  readonly v2: readonly V2Entry[];
}

export interface AdaptOptions {
  readonly upstreamRoot?: string;
  readonly outputRoot?: string;
  readonly suitesRoot?: string;
}

// ---------------------------------------------------------------------------
// Package classification
// ---------------------------------------------------------------------------

interface UpstreamPackage {
  readonly kind: "program" | "library";
  /** Canonical lionden unit id: programId (`x.aleo`) or library name (`x`). */
  readonly id: string;
  /** Subdir under `programs/` the package materializes into. */
  readonly unitDir: string;
  /** Absolute path to the upstream `src/` dir. */
  readonly srcDir: string;
  /** Entry file name under `src/`: `main.leo` (program) or `lib.leo` (library). */
  readonly entryFile: string;
}

/**
 * Classify an upstream package directory (one that holds `program.json` + `src/`).
 *
 * Classification is by source layout — `src/lib.leo` ⇒ library, `src/main.leo`
 * ⇒ program — because that is exactly what lionden's `discoverUnits` keys on.
 * `program.json` is read only as a fallback id source; lionden ignores it and
 * regenerates it during materialization.
 */
function classifyPackage(upstreamRoot: string, pkgDirRel: string): UpstreamPackage {
  const pkgDir = path.join(upstreamRoot, pkgDirRel);
  const srcDir = path.join(pkgDir, "src");
  const mainLeo = path.join(srcDir, "main.leo");
  const libLeo = path.join(srcDir, "lib.leo");
  const pkgBaseName = path.basename(pkgDirRel);

  if (fs.existsSync(libLeo)) {
    // Library: lionden's DiscoveredLibrary.name is the dir under programs/, so
    // the unit dir == canonical id == upstream package name (per plan 0b).
    return {
      kind: "library",
      id: pkgBaseName,
      unitDir: pkgBaseName,
      srcDir,
      entryFile: "lib.leo",
    };
  }
  if (!fs.existsSync(mainLeo)) {
    throw new Error(
      `Upstream package "${pkgDirRel}" has neither src/main.leo nor src/lib.leo under ${srcDir}`,
    );
  }
  const programId = extractProgramId(mainLeo) ?? readProgramJsonId(pkgDir);
  if (!programId) {
    throw new Error(`Could not determine program id for "${pkgDirRel}" (${mainLeo})`);
  }
  return {
    kind: "program",
    id: programId,
    // Program unit dir == program base name so an upgradability v2 with the
    // same program id can replace v1 in place (plan 0d).
    unitDir: programId.replace(/\.aleo$/, ""),
    srcDir,
    entryFile: "main.leo",
  };
}

function readProgramJsonId(pkgDir: string): string | null {
  const pj = path.join(pkgDir, "program.json");
  if (!fs.existsSync(pj)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pj, "utf-8")) as { program?: string };
    if (typeof parsed.program !== "string") return null;
    return parsed.program.endsWith(".aleo") ? parsed.program : `${parsed.program}.aleo`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Source rewriting — bare-library dependency reconciliation (plan 0b)
// ---------------------------------------------------------------------------

/**
 * Make bare library references visible to lionden's `.aleo`-only import parser.
 *
 * Upstream libraries are referenced bare (`abi_point_lib::Point`,
 * `abi_shape_lib::Grid::[2u32]`) with the dependency declared only as
 * `program.json` metadata — which lionden ignores. lionden's `parseImports`
 * only detects `import <id>.aleo;` / `<id>.aleo::` / `<id>.aleo/` tokens, so a
 * bare `<lib>::` reference is invisible and its dependency vanishes.
 *
 * This rewrites `<lib>::` → `<lib>.aleo::` (matching lionden's own library
 * convention, e.g. `math_utils.aleo::min(...)`) for every known library in the
 * group, and prepends `import <lib>.aleo;` to a *program* entry file for each
 * library it references — mirroring the proven `examples/multi-program` layout.
 *
 * Library entry files (`lib.leo`) get the rewrite but NOT the import: Leo 4.2.0
 * rejects `import` inside a library ("Only `const`/`struct`/`fn`/`interface`
 * are allowed in a library"). A library's cross-library dependency is instead
 * resolved purely from the `program.json` `path` entry lionden's materializer
 * writes for the `<lib>.aleo::` token detected here.
 *
 * Idempotent: `<lib>.aleo::` is not re-matched by `\b<lib>::`.
 */
function reconcileLibraryRefs(
  content: string,
  libNames: readonly string[],
  prependImports: boolean,
): { content: string; rewritten: string[] } {
  let out = content;
  const rewritten: string[] = [];

  for (const lib of libNames) {
    const bareRef = new RegExp(`\\b${escapeRegExp(lib)}::`, "g");
    if (!bareRef.test(out)) continue;
    out = out.replace(bareRef, `${lib}.aleo::`);
    rewritten.push(lib);
  }

  if (prependImports && rewritten.length > 0) {
    const importLines: string[] = [];
    for (const lib of [...rewritten].sort()) {
      const decl = `import ${lib}.aleo;`;
      // Avoid a duplicate import if the source already declares it.
      const declRe = new RegExp(`^\\s*import\\s+${escapeRegExp(lib)}\\.aleo\\s*;`, "m");
      if (!declRe.test(out)) importLines.push(decl);
    }
    if (importLines.length > 0) {
      out = `${importLines.join("\n")}\n${out}`;
    }
  }

  return { content: out, rewritten: rewritten.sort() };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Recursively list `.leo` files under `dir`, returning paths relative to `dir`. */
function listLeoFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listLeoFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".leo")) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Copy a package's `src/**` into `destDir`, rewriting bare library refs.
 * Returns per-file (relative to the project's `programs/` dir) the libraries
 * reconciled into each file.
 */
function copyAndRewrite(
  pkg: UpstreamPackage,
  destDir: string,
  libNames: readonly string[],
  relPrefix: string,
): Record<string, string[]> {
  const rewrites: Record<string, string[]> = {};
  for (const relFile of listLeoFiles(pkg.srcDir)) {
    const srcFile = path.join(pkg.srcDir, relFile);
    const destFile = path.join(destDir, relFile);
    // Imports are prepended only to a program's entry file. Library entry files
    // get the `.aleo::` rewrite but no import (Leo forbids imports in libraries).
    const prependImports = relFile === pkg.entryFile && pkg.kind === "program";
    const original = fs.readFileSync(srcFile, "utf-8");
    const { content, rewritten } = reconcileLibraryRefs(original, libNames, prependImports);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, content);
    if (rewritten.length > 0) {
      rewrites[path.join(relPrefix, relFile)] = rewritten;
    }
  }
  return rewrites;
}

function copyDirIfExists(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirIfExists(src, dest);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter entry point
// ---------------------------------------------------------------------------

export function assertUpstreamPresent(upstreamRoot: string): void {
  const sentinel = path.join(upstreamRoot, "README.md");
  const populated = fs.existsSync(upstreamRoot) && fs.readdirSync(upstreamRoot).length > 0;
  if (!populated || !fs.existsSync(sentinel)) {
    throw new Error(
      `leo-samples upstream not found at ${upstreamRoot}.\n` +
        `Initialize the submodule first:\n` +
        `  git submodule update --init test/fixtures/leo-samples/.upstream`,
    );
  }
}

/**
 * Adapt one upstream sample group into a lionden source-first project on disk
 * under `generated/<name>/` (gitignored, regenerated idempotently).
 */
export async function adaptSampleGroup(
  spec: SampleGroupSpec,
  options: AdaptOptions = {},
): Promise<AdaptedProject> {
  const upstreamRoot = options.upstreamRoot ?? DEFAULT_UPSTREAM_ROOT;
  const outputRoot = options.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const suitesRoot = options.suitesRoot ?? DEFAULT_SUITES_ROOT;
  assertUpstreamPresent(upstreamRoot);

  const projectDir = path.join(outputRoot, spec.name);
  const programsDir = path.join(projectDir, "programs");
  const programsV2Dir = path.join(projectDir, "programs.v2");
  const testDir = path.join(projectDir, "test");

  // Idempotent regen: wipe only this project's dir (preserve sibling projects
  // and generated/.gitignore at the output root).
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(programsDir, { recursive: true });

  // Classify v1 packages and learn the library names for source reconciliation.
  const packages = spec.packages.map((rel) => classifyPackage(upstreamRoot, rel));
  const libNames = packages.filter((p) => p.kind === "library").map((p) => p.id);

  let rewrites: Record<string, string[]> = {};
  for (const pkg of packages) {
    const destDir = path.join(programsDir, pkg.unitDir);
    const fileRewrites = copyAndRewrite(pkg, destDir, libNames, pkg.unitDir);
    rewrites = { ...rewrites, ...fileRewrites };
  }

  // Upgradability v2 sources: kept out of programs/ so discoverUnits ignores
  // them; copied (with the same reconciliation) into programs.v2/<base>/ plus a
  // manifest so the upgrade test can swap them in place (plan 0d).
  const v2: V2Entry[] = [];
  for (const v2spec of spec.v2Packages ?? []) {
    const v2pkg = classifyPackage(upstreamRoot, v2spec.upstreamDir);
    const base = v2spec.programId.replace(/\.aleo$/, "");
    const destDir = path.join(programsV2Dir, base);
    copyAndRewrite(v2pkg, destDir, libNames, path.join("..", "programs.v2", base));
    v2.push({
      programId: v2spec.programId,
      v2SourcePath: path.join(destDir, v2pkg.entryFile),
      targetUnitDir: path.join(programsDir, base),
    });
  }

  // Scaffolding.
  const configPath = path.join(projectDir, "lionden.config.ts");
  fs.writeFileSync(configPath, renderConfig(spec));
  fs.writeFileSync(path.join(projectDir, "package.json"), renderPackageJson(spec));
  fs.writeFileSync(path.join(projectDir, "tsconfig.json"), renderTsconfig());

  // Copy any committed authored suite for this project into the generated
  // project's test/ dir (generated projects are gitignored, so authored tests
  // cannot live inside them).
  fs.mkdirSync(testDir, { recursive: true });
  copyDirIfExists(path.join(suitesRoot, spec.name), testDir);

  // Resolve the post-adapt graph the way the compiler will, and serialize it.
  const manifest = buildManifest(spec, programsDir, rewrites, v2);
  const manifestPath = path.join(projectDir, "dependency-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    name: spec.name,
    projectDir,
    programsDir,
    configPath,
    manifestPath,
    manifest,
    testDir,
    v2,
  };
}

function buildManifest(
  spec: SampleGroupSpec,
  programsDir: string,
  rewrites: Record<string, string[]>,
  v2: readonly V2Entry[],
): DependencyManifest {
  const discovered = discoverUnits(programsDir);
  const graph = resolveDependencies(discovered);

  const units: AdaptedUnit[] = discovered
    .map((u: DiscoveredUnit) => ({
      id: unitId(u),
      kind: u.kind,
      dir: path.relative(programsDir, u.sourceDir),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const imports: Record<string, string[]> = {};
  for (const [id, deps] of graph.imports) {
    imports[id] = [...deps].sort();
  }

  return {
    project: spec.name,
    units,
    topoOrder: graph.order.map((u) => unitId(u)),
    imports,
    networkDeps: [...graph.networkDeps].sort(),
    rewrites,
    ...(spec.executionImports ? { executionImports: spec.executionImports } : {}),
    ...(v2.length > 0 ? { v2 } : {}),
  };
}
