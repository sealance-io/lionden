/**
 * Deploy task implementation.
 *
 * Deploys compiled Aleo programs to the target network with ARC-0006
 * constructor enforcement. Libraries are excluded (they are compile-only).
 *
 * When --program is specified, transitive local dependencies are included
 * and deployed first in topological order.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { ResolvedNetworkConfig } from "@lionden/config";
import type { NetworkManager, NetworkConnection } from "@lionden/network";
import {
  discoverUnits,
  resolveDependencies,
  type DiscoveredProgram,
  type DependencyGraph,
} from "@lionden/leo-compiler";
import {
  parseConstructor,
  isValidAleoAddress,
  type ConstructorInfo,
} from "./constructor-parser.js";
import { writeDeployManifest, type DeployManifest } from "./deploy-manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeployOptions {
  /** Deploy only this program (by name, e.g. "hello" or "hello.aleo") */
  program?: string;
  /** Priority fee in microcredits */
  priorityFee?: number;
  /** Skip waiting for transaction confirmation */
  skipConfirm?: boolean;
  /** Target network (overrides defaultNetwork) */
  network?: string;
  /** Skip compilation before deploying (artifacts must already exist) */
  noCompile?: boolean;
}

export interface DeployResult {
  readonly programId: string;
  readonly txId: string;
  readonly blockHeight: number;
  readonly constructorType: string;
}

// ---------------------------------------------------------------------------
// Deploy action
// ---------------------------------------------------------------------------

export async function deployAction(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
): Promise<DeployResult[]> {
  const options: DeployOptions = {
    program: args["program"] as string | undefined,
    priorityFee: args["priorityFee"] as number | undefined,
    skipConfirm: args["skipConfirm"] as boolean | undefined,
    network: args["network"] as string | undefined,
    noCompile: args["noCompile"] as boolean | undefined,
  };

  const config = lre.config;
  const artifactsDir = config.paths.artifacts;
  const programsDir = config.paths.programs;

  // 1. Compile first (unless --noCompile)
  if (!options.noCompile) {
    await lre.tasks.run("compile");
  }

  // 2. Discover all units (programs + libraries) for source-dir mapping
  //    and dependency ordering. discoverUnits is fast — directory scan only.
  const discovered = discoverUnits(programsDir);
  const programs = discovered.filter(
    (u): u is DiscoveredProgram => u.kind === "program",
  );
  const programMap = new Map(programs.map((p) => [p.programId, p]));

  // 3. Build dependency graph for topological deploy ordering
  const graph = resolveDependencies(discovered);

  // 4. Get compiled program IDs from artifacts
  const compiledIds = lre.artifacts.getProgramIds();
  if (compiledIds.length === 0) {
    throw new DeployError(
      "No compiled programs found. Run `lionden compile` first.",
    );
  }

  // 5. Resolve deploy targets in topological order (deps first)
  const targetIds = resolveDeployTargets(
    compiledIds,
    programMap,
    graph,
    options.program,
  );

  // 5. Connect to network
  const networkName = options.network ?? config.defaultNetwork;
  const networkConfig = config.networks[networkName];
  if (!networkConfig) {
    throw new DeployError(
      `Network "${networkName}" not found in config. ` +
        `Available: ${Object.keys(config.networks).join(", ") || "none"}`,
    );
  }

  const manager = lre.network as NetworkManager;
  const connection = await manager.connect(networkName);

  // 6. Deploy each program in order
  const results: DeployResult[] = [];
  const fee = options.priorityFee ?? config.deploy.defaultPriorityFee;
  const privateFee = config.deploy.privateFee;
  const shouldConfirm =
    !options.skipConfirm && config.deploy.confirmTransactions;
  const confirmTimeout = config.deploy.confirmationTimeout;

  for (const programId of targetIds) {
    const prog = programMap.get(programId);

    const result = await deploySingleProgram({
      programId,
      sourceDir: prog?.sourceDir,
      artifactsDir,
      connection,
      networkConfig,
      networkName,
      fee,
      privateFee,
      shouldConfirm,
      confirmTimeout,
      lre,
    });
    results.push(result);
    console.log(
      `Deployed ${programId} (tx: ${result.txId}, block: ${result.blockHeight})`,
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Deploy target resolution (Fix 2 + Fix 4)
// ---------------------------------------------------------------------------

/**
 * Resolve which programs to deploy and in what order.
 *
 * Uses the dependency graph (from `resolveDependencies`) for topological
 * ordering. When a specific program is requested, traverses the graph
 * to include its transitive local program dependencies.
 */
export function resolveDeployTargets(
  compiledIds: string[],
  programMap: ReadonlyMap<string, DiscoveredProgram>,
  graph: DependencyGraph,
  targetProgram?: string,
): string[] {
  if (!targetProgram) {
    // Deploy all compiled programs in dependency order from the graph.
    // graph.order is topologically sorted (dependencies before dependents).
    const ordered: string[] = [];
    for (const unit of graph.order) {
      if (unit.kind === "program" && compiledIds.includes(unit.programId)) {
        ordered.push(unit.programId);
      }
    }
    // Add any compiled programs not in the graph (safety fallback)
    for (const id of compiledIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  }

  // Normalize: add .aleo suffix if missing
  const normalized = targetProgram.endsWith(".aleo")
    ? targetProgram
    : `${targetProgram}.aleo`;

  if (!compiledIds.includes(normalized)) {
    throw new DeployError(
      `Program "${targetProgram}" not found in compiled artifacts. ` +
        `Available: ${compiledIds.join(", ")}`,
    );
  }

  // Collect transitive local program dependencies via graph traversal
  const needed = new Set<string>();
  collectTransitiveProgramDeps(normalized, graph, programMap, needed);

  // Return in topological order from the graph
  const ordered: string[] = [];
  for (const unit of graph.order) {
    if (unit.kind === "program" && needed.has(unit.programId)) {
      ordered.push(unit.programId);
    }
  }
  // Ensure target is included even if not in graph
  if (!ordered.includes(normalized)) ordered.push(normalized);

  return ordered;
}

/**
 * Recursively collect transitive local program dependencies by
 * traversing the dependency graph. Follows through libraries (which
 * are not deployed) to discover transitive program deps.
 */
function collectTransitiveProgramDeps(
  unitId: string,
  graph: DependencyGraph,
  programMap: ReadonlyMap<string, DiscoveredProgram>,
  collected: Set<string>,
  visited: Set<string> = new Set(),
): void {
  if (visited.has(unitId)) return;
  visited.add(unitId);

  // If this is a deployable program, add it
  if (programMap.has(unitId)) {
    collected.add(unitId);
  }

  // Traverse all local deps (both programs and libraries)
  const deps = graph.imports.get(unitId) ?? [];
  for (const dep of deps) {
    if (graph.networkDeps.has(dep)) continue; // skip network deps
    collectTransitiveProgramDeps(dep, graph, programMap, collected, visited);
  }
}

// ---------------------------------------------------------------------------
// Single program deploy
// ---------------------------------------------------------------------------

interface DeploySingleOptions {
  programId: string;
  /** Absolute path to the discovered source directory (from discoverUnits) */
  sourceDir?: string;
  artifactsDir: string;
  connection: NetworkConnection;
  networkConfig: ResolvedNetworkConfig;
  networkName: string;
  fee: number;
  privateFee: boolean;
  shouldConfirm: boolean;
  confirmTimeout: number;
  lre: LionDenRuntimeEnvironment;
}

async function deploySingleProgram(
  opts: DeploySingleOptions,
): Promise<DeployResult> {
  const {
    programId,
    sourceDir,
    artifactsDir,
    connection,
    networkConfig,
    networkName,
    fee,
    privateFee,
    shouldConfirm,
    confirmTimeout,
    lre,
  } = opts;

  // Read the compiled .aleo source
  const aleoSource = lre.artifacts.getAleoSource(programId);
  if (!aleoSource) {
    throw new DeployError(
      `No compiled .aleo source found for "${programId}". ` +
        `Run \`lionden compile\` first.`,
    );
  }

  // Read Leo source files for constructor parsing using the discovered
  // source directory (Fix 2: do NOT derive from programId)
  const leoSources = sourceDir
    ? readLeoSourcesFromDir(sourceDir)
    : "";

  // Parse constructor annotation
  const constructor = parseConstructor(leoSources);
  validateConstructor(constructor, programId);

  // Build and broadcast deployment transaction
  const txId = await buildAndBroadcastDeploy({
    programId,
    aleoSource,
    connection,
    networkConfig,
    fee,
    privateFee,
  });

  // Wait for confirmation
  let blockHeight = 0;
  if (shouldConfirm) {
    const confirmed = await connection.waitForConfirmation(txId, confirmTimeout);
    blockHeight = confirmed.blockHeight;
  }

  // Write deploy manifest
  const manifest: DeployManifest = {
    programId,
    network: networkName,
    endpoint: connection.endpoint,
    txId,
    blockHeight,
    edition: 0,
    constructorType: constructor!.type,
    constructorAdmin:
      constructor!.type === "admin" ? (constructor!.adminAddress ?? null) : null,
    deployedAt: new Date().toISOString(),
  };

  writeDeployManifest(artifactsDir, manifest);

  return {
    programId,
    txId,
    blockHeight,
    constructorType: constructor!.type,
  };
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

/**
 * Validate the constructor annotation. Per ARC-0006:
 * - ALL deployments MUST have a constructor — hard error if missing
 * - @admin addresses must be valid Aleo addresses
 * - @custom triggers a warning about on-chain evaluation
 */
export function validateConstructor(
  constructor: ConstructorInfo | null,
  programId: string,
): void {
  if (!constructor) {
    throw new DeployError(
      `Program "${programId}" has no constructor annotation.\n\n` +
        `Per ARC-0006, all deployments require a constructor. ` +
        `Add one of the following to your program:\n\n` +
        `  @noupgrade\n` +
        `  constructor() { ... }\n\n` +
        `  @admin(address="aleo1...")\n` +
        `  constructor() { ... }\n\n` +
        `  @custom\n` +
        `  constructor() { ... }\n`,
    );
  }

  if (constructor.type === "admin") {
    if (!constructor.adminAddress) {
      throw new DeployError(
        `Program "${programId}" has @admin constructor but no address specified.\n` +
          `Usage: @admin(address="aleo1...")`,
      );
    }
    if (!isValidAleoAddress(constructor.adminAddress)) {
      throw new DeployError(
        `Program "${programId}" has @admin constructor with invalid address: ` +
          `"${constructor.adminAddress}"\n` +
          `Aleo addresses must start with "aleo1" and be 63 characters long.`,
      );
    }
  }

  if (constructor.type === "custom") {
    console.warn(
      `Warning: Program "${programId}" uses @custom constructor. ` +
        `Custom constructor logic will be evaluated on-chain during deployment.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Transaction building
// ---------------------------------------------------------------------------

interface BuildDeployOptions {
  programId: string;
  aleoSource: string;
  connection: NetworkConnection;
  networkConfig: ResolvedNetworkConfig;
  fee: number;
  privateFee: boolean;
}

async function buildAndBroadcastDeploy(
  opts: BuildDeployOptions,
): Promise<string> {
  const { programId, aleoSource, connection, networkConfig, fee, privateFee } = opts;

  // Use SDK to build and broadcast the deployment transaction
  const { createSdkObjects, checkDevnodeSdkSupport, initConsensusHeights } =
    await import("@lionden/network");

  if (connection.type === "devnode") {
    await checkDevnodeSdkSupport();
    await initConsensusHeights();
  }

  const sdk = await createSdkObjects({
    network: connection.networkId,
    endpoint: connection.endpoint,
    privateKey: connection.privateKey,
    apiKey: connection.apiKey,
  });

  if (
    connection.type === "devnode"
  ) {
    // Devnode-specific deployment
    const tx = await sdk.programManager.buildDevnodeDeploymentTransaction({
      program: aleoSource,
      priorityFee: fee,
      privateFee,
    });

    // Broadcast via SDK network client
    return connection.broadcastTransaction(tx);
  }

  // Standard deployment — deploy() takes positional args
  return sdk.programManager.deploy(
    aleoSource,
    fee,
    privateFee,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployError";
  }
}

/**
 * Read all .leo source files from an absolute source directory.
 * Uses the discovered sourceDir (from discoverUnits) rather than
 * deriving the path from the program ID.
 */
export function readLeoSourcesFromDir(sourceDir: string): string {
  if (!fs.existsSync(sourceDir)) return "";

  const sources: string[] = [];
  collectLeoFiles(sourceDir, sources);
  return sources.join("\n");
}

function collectLeoFiles(dir: string, results: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectLeoFiles(fullPath, results);
    } else if (entry.name.endsWith(".leo")) {
      results.push(fs.readFileSync(fullPath, "utf-8"));
    }
  }
}

