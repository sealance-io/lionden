import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
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

export type FetchNetworkDep = (
  programId: string,
  endpoint: string,
  networkHint?: string,
) => Promise<string>;

/**
 * Default network dependency fetcher.
 * Fetches program source from a node's REST API: GET /{network}/program/{id}
 */
export async function defaultFetchNetworkDep(
  programId: string,
  endpoint: string,
  networkHint?: string,
): Promise<string> {
  // When the caller provides a network hint (derived from config), only try
  // that network.  Cross-network fallback would silently return source from
  // the wrong network and cache it under the hinted scope, poisoning future
  // compiles.  Only fall back across networks when no hint is given (rare —
  // means no config network was resolved).
  const networks: readonly string[] = networkHint
    ? [networkHint]
    : ["testnet", "mainnet", "canary"];

  const errors: Array<{ network: string; reason: string }> = [];

  for (const network of networks) {
    const url = `${endpoint}/${network}/program/${programId}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
      errors.push({ network, reason: `HTTP ${response.status}` });
    } catch (err) {
      errors.push({
        network,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const details = errors
    .map((e) => `  ${e.network}: ${e.reason}`)
    .join("\n");
  throw new Error(
    `Failed to fetch network dependency "${programId}" from ${endpoint}:\n${details}\n` +
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
  //    Derive the set of network deps actually needed by compileOrder
  //    (avoids fetching unrelated deps when --program filters the set).
  const cacheDir = path.join(config.paths.artifacts, ".cache");
  const selectedNetworkDeps = new Set<string>();
  for (const unit of compileOrder) {
    for (const dep of graph.imports.get(unitId(unit)) ?? []) {
      if (graph.networkDeps.has(dep)) selectedNetworkDeps.add(dep);
    }
  }

  if (selectedNetworkDeps.size > 0) {
    const networkConfig = config.networks[config.defaultNetwork];
    const endpoint =
      networkConfig?.type === "http"
        ? networkConfig.endpoint
        : networkConfig?.type === "devnode"
          ? `http://${networkConfig.socketAddr}`
          : "http://127.0.0.1:3030";
    const networkHint = networkConfig?.network;

    // Network+endpoint scope for cache isolation — devnode testnet
    // and HTTP testnet share the same network name but different sources.
    const endpointHash = crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
    const networkScope = `${networkHint ?? "default"}-${endpointHash}`;

    for (const dep of selectedNetworkDeps) {
      // Fetch once per dep; skip cache when --force is set
      let aleoSource = options.force
        ? null
        : getCachedNetworkDep(cacheDir, dep, networkScope);

      if (!aleoSource) {
        aleoSource = await fetchNetworkDep(dep, endpoint, networkHint);
      }

      // Link to every unit that imports this dep
      for (const unit of compileOrder) {
        const imports = graph.imports.get(unitId(unit)) ?? [];
        if (!imports.includes(dep)) continue;
        const pkgDir = packageDirs.get(unitId(unit))!;
        linkNetworkDependency(pkgDir, dep, aleoSource, cacheDir, networkScope);
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
    const networkDepIds: string[] = [];
    for (const dep of imports) {
      if (graph.networkDeps.has(dep)) {
        networkDepIds.push(dep);
      } else {
        localDepIds.push(dep);
        const depPkgDir = packageDirs.get(dep);
        if (depPkgDir) {
          linkLocalDependency(pkgDir, dep, path.join(depPkgDir, "build"));
        }
      }
    }

    // Compute hash and check cache
    const hash = computeUnitHash(unit, pkgDir, localDepIds, depHashes, networkDepIds);
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
    await execFileAsync(config.leoBinary, args, {
      timeout: 120_000,
      env: { ...process.env },
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
