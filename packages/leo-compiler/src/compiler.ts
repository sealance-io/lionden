import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LionDenResolvedConfig } from "@lionden/config";
import type {
  DiscoveredUnit,
  CompilationResult,
  ProgramCompilationResult,
  LibraryCompilationResult,
  CompileOptions,
} from "./types.js";
import { unitId } from "./types.js";
import { discoverUnits } from "./source-discovery.js";
import { resolveDependencies, type DependencyGraph } from "./dependency-resolver.js";
import { materializePackage, linkLocalDependency, linkNetworkDependency, getCachedNetworkDep } from "./package-materializer.js";
import { parseAbi } from "./abi-parser.js";
import { computeUnitHash, isCached, writeCache } from "./cache.js";
import type { ProgramABI } from "./abi-types.js";

const execFileAsync = promisify(execFile);

export type FetchNetworkDep = (programId: string, endpoint: string) => Promise<string>;

/**
 * Default network dependency fetcher.
 * Fetches program source from a node's REST API: GET /{network}/program/{id}
 */
export async function defaultFetchNetworkDep(
  programId: string,
  endpoint: string,
): Promise<string> {
  // Try common network paths — devnode always uses /testnet/
  for (const network of ["testnet", "mainnet", "canary"]) {
    const url = `${endpoint}/${network}/program/${programId}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // Try next network path
    }
  }
  throw new Error(
    `Failed to fetch network dependency "${programId}" from ${endpoint}. ` +
    `Ensure the endpoint is reachable and the program is deployed.`,
  );
}

export class CompilationError extends Error {
  constructor(
    public readonly unitId: string,
    message: string,
    public readonly stderr?: string,
  ) {
    super(`Compilation failed for "${unitId}": ${message}`);
    this.name = "CompilationError";
  }
}

export interface CompilePipelineResult {
  readonly results: CompilationResult[];
  readonly graph: DependencyGraph;
}

/**
 * Run the full compilation pipeline:
 * 1. Discover units
 * 2. Resolve dependencies (topological order)
 * 3. Materialize packages
 * 4. Compile in order (with caching)
 * 5. Return results with ABIs for programs
 */
export async function compilePipeline(
  config: LionDenResolvedConfig,
  options: CompileOptions = {},
  fetchNetworkDep: FetchNetworkDep = defaultFetchNetworkDep,
): Promise<CompilePipelineResult> {
  // 1. Discover
  const allUnits = discoverUnits(config.paths.programs);

  // 2. Resolve dependencies
  const graph = resolveDependencies(allUnits);

  // Filter to specific program if requested
  let compileOrder = graph.order;
  if (options.program) {
    const target = compileOrder.find(
      (u) => unitId(u) === options.program || unitId(u) === `${options.program}.aleo`,
    );
    if (!target) {
      throw new CompilationError(
        options.program,
        `Program "${options.program}" not found in ${config.paths.programs}`,
      );
    }
    // Include the target and all its transitive dependencies
    compileOrder = collectTransitiveDeps(target, graph, allUnits);
  }

  // 3. Materialize all packages (needed for dependency linking)
  const packageDirs = new Map<string, string>();
  for (const unit of compileOrder) {
    const dir = materializePackage(unit, config, graph);
    packageDirs.set(unitId(unit), dir);
  }

  // 4. Fetch and link network dependencies
  const cacheDir = path.join(config.paths.artifacts, ".cache");
  for (const dep of graph.networkDeps) {
    for (const unit of compileOrder) {
      const imports = graph.imports.get(unitId(unit)) ?? [];
      if (!imports.includes(dep)) continue;

      const pkgDir = packageDirs.get(unitId(unit))!;
      let aleoSource = getCachedNetworkDep(cacheDir, dep);

      if (!aleoSource) {
        const networkConfig = config.networks[config.defaultNetwork];
        const endpoint =
          networkConfig?.type === "http"
            ? networkConfig.endpoint
            : networkConfig?.type === "devnode"
              ? `http://${networkConfig.socketAddr}`
              : "http://127.0.0.1:3030";
        aleoSource = await fetchNetworkDep(dep, endpoint);
      }

      if (aleoSource) {
        linkNetworkDependency(pkgDir, dep, aleoSource, cacheDir);
      }
    }
  }

  // 5. Compile in topological order
  const results: CompilationResult[] = [];
  const depHashes = new Map<string, string>();

  for (const unit of compileOrder) {
    const id = unitId(unit);
    const pkgDir = packageDirs.get(id)!;
    const buildDir = path.join(pkgDir, "build");

    // Link local dependencies (their compiled .aleo output)
    const imports = graph.imports.get(id) ?? [];
    const localDepIds: string[] = [];
    for (const dep of imports) {
      if (graph.networkDeps.has(dep)) continue;
      localDepIds.push(dep);
      const depPkgDir = packageDirs.get(dep);
      if (depPkgDir) {
        linkLocalDependency(pkgDir, dep, path.join(depPkgDir, "build"));
      }
    }

    // Compute hash and check cache (only include this unit's local dep hashes)
    const hash = computeUnitHash(unit, pkgDir, localDepIds, depHashes);
    depHashes.set(id, hash);

    const cached = !options.force && isCached(cacheDir, id, hash);

    if (!cached) {
      await runLeoBuild(pkgDir, id, config);
      writeCache(cacheDir, id, hash);
    }

    if (unit.kind === "program") {
      const abi = readProgramAbi(buildDir, id);
      const aleoSource = path.join(buildDir, "main.aleo");

      // Copy final artifacts to artifactsDir/<programId>/
      const artifactDir = path.join(config.paths.artifacts, unit.programId);
      copyArtifacts(buildDir, artifactDir);

      results.push({
        unit,
        cached,
        packageDir: pkgDir,
        buildDir,
        abi,
        aleoSource,
      } satisfies ProgramCompilationResult);
    } else {
      results.push({
        unit,
        cached,
        packageDir: pkgDir,
        buildDir,
      } satisfies LibraryCompilationResult);
    }
  }

  return { results, graph };
}

async function runLeoBuild(
  packageDir: string,
  id: string,
  config: LionDenResolvedConfig,
): Promise<void> {
  const args = ["build", "--path", packageDir];

  if (config.compiler.enableDce) {
    args.push("--enable-dce");
  }

  if (config.compiler.conditionalBlockMaxDepth !== 10) {
    args.push("--conditional-block-max-depth", String(config.compiler.conditionalBlockMaxDepth));
  }

  if (config.compiler.buildTests) {
    args.push("--build-tests");
  }

  for (const flag of config.compiler.extraFlags) {
    args.push(flag);
  }

  try {
    await execFileAsync("leo", args, {
      timeout: 120_000,
      env: { ...process.env, PATH: process.env["PATH"] },
    });
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new CompilationError(id, e.message ?? "Unknown error", e.stderr);
  }
}

function readProgramAbi(buildDir: string, id: string): ProgramABI {
  const abiPath = path.join(buildDir, "abi.json");
  if (!fs.existsSync(abiPath)) {
    throw new CompilationError(id, `ABI file not found at ${abiPath}. Did leo build succeed?`);
  }
  return parseAbi(fs.readFileSync(abiPath, "utf-8"));
}

function copyArtifacts(buildDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });

  // Copy all relevant files: abi.json, main.aleo, *.prover, *.verifier
  if (!fs.existsSync(buildDir)) return;

  for (const file of fs.readdirSync(buildDir)) {
    if (
      file === "abi.json" ||
      file === "main.aleo" ||
      file.endsWith(".prover") ||
      file.endsWith(".verifier")
    ) {
      fs.copyFileSync(path.join(buildDir, file), path.join(destDir, file));
    }
  }
}

/**
 * Collect a unit and all its transitive local dependencies in topological order.
 */
function collectTransitiveDeps(
  target: DiscoveredUnit,
  graph: DependencyGraph,
  allUnits: DiscoveredUnit[],
): DiscoveredUnit[] {
  const needed = new Set<string>();
  const unitMap = new Map<string, DiscoveredUnit>();
  for (const u of allUnits) unitMap.set(unitId(u), u);

  function collect(id: string): void {
    if (needed.has(id)) return;
    needed.add(id);
    for (const dep of graph.imports.get(id) ?? []) {
      if (!graph.networkDeps.has(dep) && unitMap.has(dep)) {
        collect(dep);
      }
    }
  }

  collect(unitId(target));

  // Return in original topological order, filtered to needed
  return graph.order.filter((u) => needed.has(unitId(u)));
}
