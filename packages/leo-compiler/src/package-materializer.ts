import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import type { DiscoveredUnit, DiscoveredProgram, DiscoveredLibrary } from "./types.js";
import { unitId } from "./types.js";
import type { DependencyGraph } from "./dependency-resolver.js";

/**
 * Materialize a Leo CLI package for a discovered unit under
 * `<artifactsDir>/.build/<id>/`.
 *
 * This is the "unflatten" stage: users write .leo files in programs/
 * without program.json, imports/, etc. We create the full Leo CLI package
 * structure that `leo build` expects.
 */
export function materializePackage(
  unit: DiscoveredUnit,
  config: LionDenResolvedConfig,
  graph: DependencyGraph,
): string {
  const id = unitId(unit);
  const packageDir = path.join(config.paths.artifacts, ".build", id);
  const srcDir = path.join(packageDir, "src");
  const importsDir = path.join(packageDir, "imports");

  // Clean and recreate, but preserve the build/ directory (contains leo build
  // output that the cache expects to still be there on subsequent runs).
  const buildDir = path.join(packageDir, "build");
  const buildExists = fs.existsSync(buildDir);
  const tmpBuildDir = buildExists
    ? path.join(config.paths.artifacts, ".build", `.preserve-${id}-${process.pid}`)
    : null;
  if (tmpBuildDir) {
    fs.renameSync(buildDir, tmpBuildDir);
  }
  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(importsDir, { recursive: true });
  if (tmpBuildDir) {
    fs.renameSync(tmpBuildDir, buildDir);
  }

  // Copy all .leo sources preserving directory structure
  for (const relPath of unit.allSources) {
    const src = path.join(unit.sourceDir, relPath);
    const dest = path.join(srcDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  // Generate program.json
  const programJson = buildProgramJson(unit, config, graph);
  fs.writeFileSync(
    path.join(packageDir, "program.json"),
    JSON.stringify(programJson, null, 2) + "\n",
  );

  // Generate .env
  const env = buildDotEnv(config);
  fs.writeFileSync(path.join(packageDir, ".env"), env);

  return packageDir;
}

interface LeoDepEntry {
  name: string;
  location: "local" | "network";
  path?: string;
}

function buildProgramJson(
  unit: DiscoveredUnit,
  config: LionDenResolvedConfig,
  graph: DependencyGraph,
): Record<string, unknown> {
  const id = unitId(unit);
  const imports = graph.imports.get(id) ?? [];

  // Leo CLI expects the program field to use the .aleo suffix for both
  // programs and libraries (matching import syntax, e.g. "math_utils.aleo").
  const programName = unit.kind === "program"
    ? (unit as DiscoveredProgram).programId
    : `${(unit as DiscoveredLibrary).name}.aleo`;

  const dependencies: LeoDepEntry[] = [];

  for (const dep of imports) {
    if (graph.networkDeps.has(dep)) {
      dependencies.push({ name: dep, location: "network" });
    } else {
      // Local dependency — point to its materialized package.
      // Leo CLI expects dependency names to match import statements
      // (e.g. "math_utils.aleo"), but libraries have canonical IDs
      // without the .aleo suffix, so we normalize here.
      const depName = dep.endsWith(".aleo") ? dep : `${dep}.aleo`;
      const depPackageDir = path.join(config.paths.artifacts, ".build", dep);
      dependencies.push({ name: depName, location: "local", path: depPackageDir });
    }
  }

  return {
    program: programName,
    version: "0.1.0",
    description: "",
    license: "MIT",
    dependencies: dependencies.length > 0 ? dependencies : undefined,
  };
}

function buildDotEnv(config: LionDenResolvedConfig): string {
  const networkConfig = config.networks[config.defaultNetwork];
  const lines: string[] = [];

  // Every resolved network config carries a `network` field — use it directly.
  lines.push(`NETWORK=${networkConfig?.network ?? "testnet"}`);

  if (networkConfig?.type === "http" && networkConfig.privateKey) {
    lines.push(`PRIVATE_KEY=${networkConfig.privateKey}`);
  } else {
    // Default devnode private key (recommended by Leo CLI for local devnets)
    lines.push("PRIVATE_KEY=APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH");
  }

  if (networkConfig?.type === "http") {
    lines.push(`ENDPOINT=${networkConfig.endpoint}`);
  } else if (networkConfig?.type === "devnode") {
    lines.push(`ENDPOINT=http://${networkConfig.socketAddr}`);
  } else {
    lines.push("ENDPOINT=http://127.0.0.1:3030");
  }

  if (networkConfig?.type === "devnode") {
    lines.push("DEVNET=true");
  }

  return lines.join("\n") + "\n";
}

/**
 * Copy a normalized compiled dependency .aleo output into the dependent
 * package's imports/ directory. Called after the dependency has been compiled.
 */
export function linkLocalDependency(
  dependentPackageDir: string,
  depName: string,
  depArtifactDir: string,
): void {
  const importsDir = path.join(dependentPackageDir, "imports");
  fs.mkdirSync(importsDir, { recursive: true });

  const aleoFile = path.join(depArtifactDir, "main.aleo");
  if (fs.existsSync(aleoFile)) {
    fs.copyFileSync(aleoFile, path.join(importsDir, depName.endsWith(".aleo") ? depName : `${depName}.aleo`));
  }
}

/**
 * Cache a network dependency's .aleo source into the cache directory
 * and copy it into the package's imports/ directory.
 *
 * Cache is scoped by effective network+endpoint so that switching
 * `defaultNetwork` in config does not serve stale source from a different
 * network or endpoint.
 */
export function linkNetworkDependency(
  packageDir: string,
  depName: string,
  aleoSource: string,
  cacheDir: string,
  networkScope?: string,
): void {
  // Cache the source (scoped by network+endpoint)
  const scope = networkScope ?? "default";
  const cachePath = path.join(cacheDir, "network-deps", scope, depName);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, aleoSource);

  // Copy to imports/
  const importsDir = path.join(packageDir, "imports");
  fs.mkdirSync(importsDir, { recursive: true });
  fs.writeFileSync(path.join(importsDir, depName), aleoSource);
}

/**
 * Check if a network dependency is already cached.
 *
 * Cache is scoped by network+endpoint — see {@link linkNetworkDependency}.
 */
export function getCachedNetworkDep(
  cacheDir: string,
  depName: string,
  networkScope?: string,
): string | null {
  const scope = networkScope ?? "default";
  const cachePath = path.join(cacheDir, "network-deps", scope, depName);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, "utf-8");
  }
  return null;
}
