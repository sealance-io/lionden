import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { LionDenResolvedConfig } from "@lionden/config";
import {
  fingerprintFile,
  type KeyArtifactFunctionRef,
  type KeyArtifactsMetadata,
  type KeyFileRef,
  keyArtifactsMetadataPath,
  sha256Json,
  sha256Text,
  writeKeyArtifactsMetadata,
} from "@lionden/core";
import { parseAbi } from "./abi-parser.js";
import type { ProgramABI } from "./abi-types.js";
import { computeUnitHash, isCached, writeCache } from "./cache.js";
import { type DependencyGraph, resolveDependencies } from "./dependency-resolver.js";
import {
  getCachedNetworkDep,
  linkNetworkDependency,
  materializePackage,
} from "./package-materializer.js";
import { discoverUnits } from "./source-discovery.js";
import type {
  CompilationResult,
  CompileOptions,
  DiscoveredUnit,
  LibraryCompilationResult,
  ProgramCompilationResult,
} from "./types.js";
import { unitId } from "./types.js";

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

  const details = errors.map((e) => `  ${e.network}: ${e.reason}`).join("\n");
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

/**
 * Derive the network-dependency cache scope for a given network, plus the
 * endpoint + hint used to fetch from it.
 *
 * `compilePipeline` scopes the network-dep cache by effective network+endpoint
 * (`${networkHint}-${sha256(endpoint).slice(0,8)}`) so switching networks does
 * not serve stale source. This is the single source of truth for that
 * derivation — callers that need to pre-seed or locate the cache (e.g. tests)
 * must use this rather than re-deriving the scope, so the two can never drift.
 */
export function networkDepCacheScope(
  config: LionDenResolvedConfig,
  networkName: string,
): { readonly endpoint: string; readonly networkHint: string | undefined; readonly scope: string } {
  const networkConfig = config.networks[networkName];
  const endpoint =
    networkConfig?.type === "http"
      ? networkConfig.endpoint
      : networkConfig?.type === "devnode"
        ? `http://${networkConfig.socketAddr}`
        : "http://127.0.0.1:3030";
  const networkHint = networkConfig?.network;
  // Network+endpoint scope for cache isolation — devnode testnet and HTTP
  // testnet share the same network name but different sources.
  const endpointHash = crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
  const scope = `${networkHint ?? "default"}-${endpointHash}`;
  return { endpoint, networkHint, scope };
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
  // Resolve the effective network for network-dep fetch + `.env`. A programmatic
  // `{ network }` (forwarded from deploy/recipe/upgrade) retargets these from
  // `config.defaultNetwork` so imported on-chain sources are fetched from the
  // deploying network. Validate whenever an override is *present* (not just
  // truthy) before deriving the endpoint/hint — an explicit `""` is still an
  // unknown network and must throw here rather than slipping through to the
  // `""`-keyed `config.networks` miss and the `127.0.0.1:3030` fallback below.
  if (options.network !== undefined && !config.networks[options.network]) {
    throw new Error(
      `Network "${options.network}" is not defined in config.networks. ` +
        `Available networks: ${Object.keys(config.networks).join(", ") || "(none)"}`,
    );
  }
  const effectiveNetwork = options.network ?? config.defaultNetwork;

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
    const dir = materializePackage(unit, config, graph, effectiveNetwork);
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
    const {
      endpoint,
      networkHint,
      scope: networkScope,
    } = networkDepCacheScope(config, effectiveNetwork);

    for (const dep of selectedNetworkDeps) {
      // Fetch once per dep; skip cache when --force is set
      let aleoSource = options.force ? null : getCachedNetworkDep(cacheDir, dep, networkScope);

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

    // Partition imports into local vs network deps for cache hashing.
    // Local deps need no staging: `leo build` resolves them from the `path`
    // entry in the dependent's program.json (written by materializePackage)
    // and re-emits each dependency's bytecode under the dependent's own
    // build/ dir. Network deps are staged into imports/ by linkNetworkDependency.
    const imports = graph.imports.get(id) ?? [];
    const localDepIds: string[] = [];
    const networkDepIds: string[] = [];
    for (const dep of imports) {
      if (graph.networkDeps.has(dep)) {
        networkDepIds.push(dep);
      } else {
        localDepIds.push(dep);
      }
    }

    // Compute hash and check cache
    const hash = computeUnitHash(unit, pkgDir, localDepIds, depHashes, networkDepIds);
    depHashes.set(id, hash);

    const hashMatches = !options.force && isCached(cacheDir, id, hash);
    // A program hash hit only counts if the build output it still needs (ABI +
    // compiled .aleo) survived in the preserved build/ dir; otherwise the later
    // ABI read / artifact copy would fail. Libraries are inline `fn` helpers
    // that emit no build artifacts, so there is nothing to revalidate.
    const cached =
      hashMatches && (unit.kind !== "program" || hasRequiredProgramArtifacts(buildDir, id));

    if (!cached) {
      await runLeoBuild(pkgDir, id, config);
    }

    if (unit.kind === "program") {
      const abi = readProgramAbi(buildDir, id);

      // Copy final artifacts to artifactsDir/<programId>/
      const artifactDir = path.join(config.paths.artifacts, unit.programId);
      const normalized = copyArtifacts(buildDir, artifactDir, id, {
        requireAbi: true,
        requireAleo: true,
      });
      writeKeyArtifactsMetadata(
        keyArtifactsMetadataPath(config.paths.artifacts, unit.programId),
        buildKeyArtifactsMetadata(pkgDir, artifactDir, unit.programId, abi),
      );

      results.push({
        unit,
        cached,
        packageDir: pkgDir,
        buildDir,
        abi,
        aleoSource: normalized.aleoPath!,
      } satisfies ProgramCompilationResult);
    } else {
      // Libraries are inline `fn` helpers: `leo build` emits no .aleo for them,
      // and dependents inline the source from the library's package `path` in
      // program.json — never from a staged .aleo. So there is nothing to
      // normalize or stage for a library.
      results.push({
        unit,
        cached,
        packageDir: pkgDir,
        buildDir,
      } satisfies LibraryCompilationResult);
    }
    if (!cached) {
      writeCache(cacheDir, id, hash);
    }
  }

  return { results, graph };
}

async function runLeoBuild(
  packageDir: string,
  id: string,
  config: LionDenResolvedConfig,
): Promise<void> {
  const args = ["--disable-update-check", "build", "--path", packageDir];

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
  const artifacts = resolveBuildArtifacts(buildDir, id);
  if (!artifacts.abiPath) {
    throw new CompilationError(id, `ABI file not found under ${buildDir}. Did leo build succeed?`);
  }
  const abi = parseAbi(fs.readFileSync(artifacts.abiPath, "utf-8"));
  if (abi.program !== id) {
    throw new CompilationError(
      id,
      `Resolved ABI belongs to program "${abi.program}", expected "${id}".`,
    );
  }
  return abi;
}

function hasRequiredProgramArtifacts(buildDir: string, id: string): boolean {
  const artifacts = resolveBuildArtifacts(buildDir, id);
  return Boolean(artifacts.abiPath && artifacts.aleoPath);
}

interface CopyArtifactOptions {
  readonly requireAbi: boolean;
  readonly requireAleo: boolean;
}

interface NormalizedArtifactPaths {
  readonly abiPath?: string;
  readonly aleoPath?: string;
}

function copyArtifacts(
  buildDir: string,
  destDir: string,
  id: string,
  options: CopyArtifactOptions,
): NormalizedArtifactPaths {
  const artifacts = resolveBuildArtifacts(buildDir, id);
  if (options.requireAbi && !artifacts.abiPath) {
    throw new CompilationError(id, `ABI file not found under ${buildDir}. Did leo build succeed?`);
  }
  if (options.requireAleo && !artifacts.aleoPath) {
    throw new CompilationError(
      id,
      `Compiled Aleo source not found under ${buildDir}. Did leo build succeed?`,
    );
  }

  // `artifacts/<programId>` is compiler-owned output. Recreate it from
  // scratch so stale legacy/per-unit artifacts cannot survive normalization.
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const normalized: { abiPath?: string; aleoPath?: string } = {};

  if (artifacts.abiPath) {
    normalized.abiPath = path.join(destDir, "abi.json");
    fs.copyFileSync(artifacts.abiPath, normalized.abiPath);
  }
  if (artifacts.aleoPath) {
    normalized.aleoPath = path.join(destDir, "main.aleo");
    fs.copyFileSync(artifacts.aleoPath, normalized.aleoPath);
  }

  for (const file of artifacts.keyFiles) {
    fs.copyFileSync(file, path.join(destDir, path.basename(file)));
  }

  for (const interfacesDir of artifacts.interfacesDirs) {
    copyDirectory(interfacesDir, path.join(destDir, "interfaces"));
  }

  return normalized;
}

interface ResolvedBuildArtifacts {
  readonly abiPath?: string;
  readonly aleoPath?: string;
  readonly keyFiles: readonly string[];
  readonly interfacesDirs: readonly string[];
}

function resolveBuildArtifacts(buildDir: string, id: string): ResolvedBuildArtifacts {
  if (!fs.existsSync(buildDir)) {
    return { keyFiles: [], interfacesDirs: [] };
  }

  const unitDir = findBuildUnitDir(buildDir, id);
  const abiPath = existingFile(path.join(unitDir, "abi.json"));
  const aleoPath = findAleoOutput(unitDir, id);

  const keyFiles = fs.existsSync(unitDir)
    ? fs
        .readdirSync(unitDir)
        .filter((file) => file.endsWith(".prover") || file.endsWith(".verifier"))
        .map((file) => path.join(unitDir, file))
        .sort((a, b) => a.localeCompare(b))
    : [];

  const interfacesDirs = [
    path.join(unitDir, "interfaces"),
    path.join(buildDir, "interfaces"),
  ].filter(
    (dir, index, dirs) =>
      fs.existsSync(dir) && fs.statSync(dir).isDirectory() && dirs.indexOf(dir) === index,
  );

  return { abiPath, aleoPath, keyFiles, interfacesDirs };
}

function findBuildUnitDir(buildDir: string, id: string): string {
  const preferred = preferredBuildUnitDirs(buildDir, id);
  return newestBuildArtifactMatch(preferred, id) ?? buildDir;
}

function preferredBuildUnitDirs(buildDir: string, id: string): string[] {
  const base = id.endsWith(".aleo") ? id.slice(0, -".aleo".length) : id;
  return uniqueExistingDirs([buildDir, path.join(buildDir, id), path.join(buildDir, base)]);
}

function newestBuildArtifactMatch(dirs: readonly string[], id: string): string | undefined {
  const matches = dirs
    .map((dir, index) => {
      const abiPath = existingFile(path.join(dir, "abi.json"));
      const aleoPath = findAleoOutput(dir, id);
      const artifactPath = abiPath ?? aleoPath;
      return artifactPath ? { dir, index, mtimeMs: fs.statSync(artifactPath).mtimeMs } : null;
    })
    .filter((match): match is { dir: string; index: number; mtimeMs: number } => match !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.index - b.index);
  return matches[0]?.dir;
}

function uniqueExistingDirs(dirs: readonly string[]): string[] {
  return [...new Set(dirs)].filter((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
}

function findAleoOutput(dir: string, id: string): string | undefined {
  const base = id.endsWith(".aleo") ? id.slice(0, -".aleo".length) : id;
  const candidateNames = ["main.aleo", id.endsWith(".aleo") ? id : `${id}.aleo`, `${base}.aleo`];
  for (const name of [...new Set(candidateNames)]) {
    const file = existingFile(path.join(dir, name));
    if (file) return file;
  }

  if (!fs.existsSync(dir)) return undefined;
  const aleoFiles = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".aleo") && fs.statSync(path.join(dir, file)).isFile())
    .sort((a, b) => a.localeCompare(b));
  return aleoFiles.length > 0 ? path.join(dir, aleoFiles[0]!) : undefined;
}

function existingFile(filePath: string): string | undefined {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : undefined;
}

function copyDirectory(srcDir: string, destDir: string): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(src, dest);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

function buildKeyArtifactsMetadata(
  packageDir: string,
  artifactDir: string,
  programId: string,
  abi: ProgramABI,
): KeyArtifactsMetadata {
  const sourcePath = path.join(artifactDir, "main.aleo");
  const sourceHash = fs.existsSync(sourcePath)
    ? sha256Text(fs.readFileSync(sourcePath, "utf-8"))
    : sha256Text("");
  const functions = collectKeyArtifactFunctionRefs(artifactDir, programId, abi);

  return {
    format: "lionden.keyArtifacts.v1",
    programId,
    sourceHash,
    importsHash: hashPackageImports(path.join(packageDir, "imports")),
    ...(functions.length === 0 ? {} : { functions }),
  };
}

/**
 * Hash the materialized package `imports/` directory for the key-artifacts
 * sidecar. Local program deps are not staged here; Leo resolves them through
 * the `path` entries in program.json. See docs/research/key-caching.md for the
 * distinction between this compile-time hash and the runtime key-cache hash.
 */
function hashPackageImports(importsDir: string): string {
  if (!fs.existsSync(importsDir)) {
    return sha256Json({ imports: [] });
  }

  const imports = listFilesRecursive(importsDir).map((filePath) => {
    const relativePath = toPortablePath(path.relative(importsDir, filePath));
    return {
      path: relativePath,
      sourceHash: sha256Text(fs.readFileSync(filePath, "utf-8")),
    };
  });

  return sha256Json({ imports });
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(entryPath));
    } else if (entry.isFile()) {
      out.push(entryPath);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function collectKeyArtifactFunctionRefs(
  artifactDir: string,
  programId: string,
  abi: ProgramABI,
): KeyArtifactFunctionRef[] {
  if (!fs.existsSync(artifactDir)) return [];

  const proverByStem = new Map<string, string>();
  const verifierByStem = new Map<string, string>();
  for (const file of fs.readdirSync(artifactDir)) {
    const filePath = path.join(artifactDir, file);
    if (!fs.statSync(filePath).isFile()) continue;
    if (file.endsWith(".prover")) {
      proverByStem.set(file.slice(0, -".prover".length), file);
    } else if (file.endsWith(".verifier")) {
      verifierByStem.set(file.slice(0, -".verifier".length), file);
    }
  }

  const pairedStems = [...proverByStem.keys()]
    .filter((stem) => verifierByStem.has(stem))
    .sort((a, b) => a.localeCompare(b));
  if (pairedStems.length === 0) return [];

  return abi.transitions.flatMap((transition) => {
    const stem = findUnambiguousKeyStem(
      pairedStems,
      programId,
      transition.name,
      abi.transitions.length,
    );
    if (!stem) return [];
    const prover = proverByStem.get(stem);
    const verifier = verifierByStem.get(stem);
    if (!prover || !verifier) return [];
    return [
      {
        transition: transition.name,
        prover: keyFileRef(artifactDir, prover),
        verifier: keyFileRef(artifactDir, verifier),
      },
    ];
  });
}

function findUnambiguousKeyStem(
  pairedStems: readonly string[],
  programId: string,
  transition: string,
  transitionCount: number,
): string | undefined {
  const programBase = programId.endsWith(".aleo") ? programId.slice(0, -".aleo".length) : programId;
  const candidates = [
    transition,
    `${programBase}.${transition}`,
    `${programId}.${transition}`,
    `${programBase}_${transition}`,
  ];
  for (const candidate of candidates) {
    if (pairedStems.includes(candidate)) return candidate;
  }
  return transitionCount === 1 && pairedStems.length === 1 ? pairedStems[0] : undefined;
}

function keyFileRef(artifactDir: string, file: string): KeyFileRef {
  const filePath = path.join(artifactDir, file);
  return {
    path: toPortablePath(path.relative(artifactDir, filePath)),
    fingerprint: fingerprintFile(filePath),
  };
}

function toPortablePath(p: string): string {
  return p.split(path.sep).join("/");
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
