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

  // Clean and recreate
  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(importsDir, { recursive: true });

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

  // Programs use "hello.aleo", libraries use "math_utils" (no .aleo suffix)
  const programName = unit.kind === "program"
    ? (unit as DiscoveredProgram).programId
    : (unit as DiscoveredLibrary).name;

  const dependencies: LeoDepEntry[] = [];

  for (const dep of imports) {
    if (graph.networkDeps.has(dep)) {
      dependencies.push({ name: dep, location: "network" });
    } else {
      // Local dependency — point to its materialized package
      const depPackageDir = path.join(config.paths.artifacts, ".build", dep);
      dependencies.push({ name: dep, location: "local", path: depPackageDir });
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

  lines.push(`NETWORK=${networkConfig?.type === "http" ? networkConfig.network : "testnet"}`);

  if (networkConfig?.type === "http" && networkConfig.privateKey) {
    lines.push(`PRIVATE_KEY=${networkConfig.privateKey}`);
  } else {
    // Default devnode private key
    lines.push("PRIVATE_KEY=APrivateKey1zkp8CZNn3yeCBJ4tRPxGzmKnVmpVCjkMWqGz3JhHUAyqDJ1");
  }

  if (networkConfig?.type === "http") {
    lines.push(`ENDPOINT=${networkConfig.endpoint}`);
  } else if (networkConfig?.type === "devnode") {
    lines.push(`ENDPOINT=http://${networkConfig.socketAddr}`);
  } else {
    lines.push("ENDPOINT=http://127.0.0.1:3030");
  }

  return lines.join("\n") + "\n";
}

/**
 * Copy a compiled dependency's .aleo output into the dependent package's
 * imports/ directory. Called after the dependency has been compiled.
 */
export function linkLocalDependency(
  dependentPackageDir: string,
  depName: string,
  depBuildDir: string,
): void {
  const importsDir = path.join(dependentPackageDir, "imports");
  fs.mkdirSync(importsDir, { recursive: true });

  const aleoFile = path.join(depBuildDir, "main.aleo");
  if (fs.existsSync(aleoFile)) {
    fs.copyFileSync(aleoFile, path.join(importsDir, depName.endsWith(".aleo") ? depName : `${depName}.aleo`));
  }
}

/**
 * Cache a network dependency's .aleo source into the cache directory
 * and copy it into the package's imports/ directory.
 */
export function linkNetworkDependency(
  packageDir: string,
  depName: string,
  aleoSource: string,
  cacheDir: string,
): void {
  // Cache the source
  const cachePath = path.join(cacheDir, "network-deps", depName);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, aleoSource);

  // Copy to imports/
  const importsDir = path.join(packageDir, "imports");
  fs.mkdirSync(importsDir, { recursive: true });
  fs.writeFileSync(path.join(importsDir, depName), aleoSource);
}

/**
 * Check if a network dependency is already cached.
 */
export function getCachedNetworkDep(
  cacheDir: string,
  depName: string,
): string | null {
  const cachePath = path.join(cacheDir, "network-deps", depName);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, "utf-8");
  }
  return null;
}
