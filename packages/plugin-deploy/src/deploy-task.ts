import type {
  ResolvedNetworkConfig,
  ResolvedSdkKeyCacheConfig,
  SdkLogLevel,
} from "@lionden/config";
import { isSignable } from "@lionden/config";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import {
  computeAbiHash,
  type DependencyGraph,
  type DiscoveredProgram,
  discoverUnits,
  type ProgramABI,
  resolveDependencies,
} from "@lionden/leo-compiler";
import type { NetworkConnection, NetworkManager, SdkEgressPolicy } from "@lionden/network";
import {
  type ConstructorInfo,
  extractConstructorFingerprint,
  isValidAleoAddress,
  parseConstructor,
} from "./constructor-parser.js";
import type { DeploymentManager } from "./deployment-manager.js";
import type { CompleteDeploymentRecord, PendingDeployment } from "./deployment-types.js";
import { DeployError } from "./errors.js";
import { readLeoSourcesFromDir as readLeoSourcesFromDirImpl } from "./leo-sources.js";
import { createDegradedRecord } from "./on-chain-check.js";
import { type DeployPreflightResult, runDeployPreflight } from "./preflight.js";
import { resolveProveOption } from "./prove.js";

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
  /** Run pre-flight checks only — do not deploy */
  preflight?: boolean;
  /** Build transaction but do not broadcast (devnode only) */
  dryRun?: boolean;
  /** Fail if any program is already deployed on-chain */
  noSkipDeployed?: boolean;
  /** Export deployment bundle after deploying */
  export?: boolean;
  /** Build a standard/proven transaction even on devnode. */
  prove?: boolean;
}

export interface DeployResult {
  readonly programId: string;
  readonly txId: string;
  readonly blockHeight: number;
  readonly constructorType: string;
}

export interface DryRunResult {
  readonly programId: string;
  readonly transaction: unknown;
  readonly estimatedFee: bigint;
}

export type DeployTaskResult =
  | { readonly mode: "deploy"; readonly results: DeployResult[] }
  | { readonly mode: "preflight"; readonly result: DeployPreflightResult }
  | { readonly mode: "dry-run"; readonly results: DryRunResult[] };

// ---------------------------------------------------------------------------
// Deploy action
// ---------------------------------------------------------------------------

export async function deployAction(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
): Promise<DeployTaskResult> {
  const options: DeployOptions = {
    program: args["program"] as string | undefined,
    priorityFee: args["priorityFee"] as number | undefined,
    skipConfirm: args["skipConfirm"] as boolean | undefined,
    network: args["network"] as string | undefined,
    noCompile: args["noCompile"] as boolean | undefined,
    preflight: args["preflight"] as boolean | undefined,
    dryRun: args["dryRun"] as boolean | undefined,
    noSkipDeployed: args["noSkipDeployed"] as boolean | undefined,
    export: args["export"] as boolean | undefined,
    prove: resolveProveOption(args, lre),
  };

  const config = lre.config;
  const programsDir = config.paths.programs;
  const manager = lre.deployments as DeploymentManager | null;

  // 1. Compile first (unless --noCompile or --preflight). Forward the effective
  // deployment network (when explicitly supplied) so the implicit compile
  // resolves imported on-chain sources + `.env` from the deploying network.
  // Omit it on a default run so compile falls back to `config.defaultNetwork`
  // (byte-for-byte unchanged).
  if (!options.noCompile && !options.preflight) {
    const compileArgs: Record<string, unknown> = {};
    if (options.program) compileArgs["program"] = options.program;
    if (options.network) compileArgs["network"] = options.network;
    if (Object.keys(compileArgs).length > 0) {
      await lre.tasks.run("compile", compileArgs);
    } else {
      await lre.tasks.run("compile");
    }
  }

  // 2. Discover all units for source-dir mapping and dependency ordering
  const discovered = discoverUnits(programsDir);
  const programs = discovered.filter((u): u is DiscoveredProgram => u.kind === "program");
  const programMap = new Map(programs.map((p) => [p.programId, p]));
  const graph = resolveDependencies(discovered);

  // 3. Determine candidate program IDs for target resolution.
  // In --preflight mode compilation is skipped, so artifacts may be absent.
  // Use discovered program IDs so runDeployPreflight() can emit MISSING_ARTIFACTS
  // per program rather than throwing here before any structured result is produced.
  // In normal (deploy/dry-run) mode, only compiled IDs are valid targets.
  const compiledIds = lre.artifacts.getProgramIds();
  const candidateIds = options.preflight ? programs.map((p) => p.programId) : compiledIds;

  if (!options.preflight && compiledIds.length === 0) {
    throw new DeployError("No compiled programs found. Run `lionden compile` first.");
  }

  // 4. Resolve deploy targets in topological order (deps first)
  const targetIds = resolveDeployTargets(candidateIds, programMap, graph, options.program);

  // 5. Connect to network
  const networkName = options.network ?? config.defaultNetwork;
  const networkConfig = config.networks[networkName];
  if (!networkConfig) {
    throw new DeployError(
      `Network "${networkName}" not found in config. ` +
        `Available: ${Object.keys(config.networks).join(", ") || "none"}`,
    );
  }

  const networkManager = lre.network as NetworkManager;
  const connection = await networkManager.connect(networkName);

  // 5b. Resolve deployer signer from namedAccounts (if configured)
  let deployerSignerKey: string | undefined;
  const namedDeployer = lre.namedAccounts["deployer"];
  if (namedDeployer !== undefined) {
    if (!isSignable(namedDeployer)) {
      throw new DeployError(
        `Named account "deployer" is configured as address-only for network "${networkName}". ` +
          `The deployer role requires a signable account (private key or devnode account index). ` +
          `Provide a private key or devnode index in your namedAccounts config.`,
      );
    }
    deployerSignerKey = namedDeployer.privateKey;
  }

  // 6. Recover pending deployments from previous runs
  if (manager) {
    await manager.recoverPendingDeployments(networkName, connection);
  }

  // 7. Build local sources map (compiled Aleo sources for all targets)
  const localSources = new Map<string, string>();
  for (const programId of targetIds) {
    const source = lre.artifacts.getAleoSource(programId);
    if (source) localSources.set(programId, source);
  }

  // 8. Build preflight program entries
  // Use getDeployment() (async, validates disk/on-chain) instead of getCached() so that HTTP
  // disk state is loaded into the preflight even on a cold-cache (fresh CLI process).
  const preflightPrograms: Array<{
    programId: string;
    constructor: ConstructorInfo | null;
    aleoSource: string | undefined;
    existingRecord: import("./deployment-types.js").DeploymentRecord | null;
  }> = [];
  for (const programId of targetIds) {
    const prog = programMap.get(programId);
    const leoSources = prog ? readLeoSourcesFromDirImpl(prog.sourceDir) : "";
    const constructor = parseConstructor(leoSources);
    const aleoSourceRaw = lre.artifacts.getAleoSource(programId);
    const aleoSource = typeof aleoSourceRaw === "string" ? aleoSourceRaw : undefined;
    // Devnode: use sync cache — it's populated as programs are deployed in this session
    //          and avoids unnecessary getProgramSource() calls before the program exists.
    // HTTP: use async getDeployment() to load validated disk state on a cold-cache process.
    const existingRecord = manager
      ? connection.type === "devnode"
        ? (manager.getCached(programId, networkName) ?? null)
        : await manager.getDeployment(programId, networkName)
      : null;
    preflightPrograms.push({ programId, constructor, aleoSource, existingRecord });
  }

  // 9. Run pre-flight validation
  const skipDeployed = !options.noSkipDeployed && config.deploy.skipDeployed;
  const deployTargets = new Set(targetIds);

  const preflightResult = await runDeployPreflight({
    programs: preflightPrograms,
    connection,
    networkConfig,
    config,
    skipDeployed,
    deployTargets,
    localSources,
    graph,
    signerPrivateKey: deployerSignerKey,
  });

  // 10. If --preflight, return pure check result (no state mutations)
  if (options.preflight) {
    return { mode: "preflight", result: preflightResult };
  }

  // 11. Fail if preflight has errors (not just warnings)
  if (!preflightResult.passed) {
    const errorMessages = preflightResult.errors
      .map((e) => `  [${e.code}] ${e.message}`)
      .join("\n");
    throw new DeployError(`Pre-flight validation failed:\n${errorMessages}`);
  }

  // 12. Filter to programs that need deploying from preflight outcomes
  const toDeployIds = preflightResult.programs
    .filter((p) => p.action === "deploy")
    .map((p) => p.programId);

  // 13. If --dry-run, build transactions without broadcasting (devnode only).
  // This must happen BEFORE reconciliation so dry-run never mutates deployment state.
  if (options.dryRun) {
    if (connection.type !== "devnode") {
      throw new DeployError(
        `Dry-run is not supported for HTTP networks in v1. ` +
          `Use --preflight for validation without deployment.`,
      );
    }

    const dryRunResults: DryRunResult[] = [];
    for (const programId of toDeployIds) {
      const aleoSource = lre.artifacts.getAleoSource(programId);
      if (!aleoSource) continue;

      const tx = await buildDeployTransaction({
        programId,
        aleoSource,
        connection,
        fee: options.priorityFee ?? config.deploy.defaultPriorityFee,
        privateFee: config.deploy.privateFee,
        signerPrivateKey: deployerSignerKey,
        prove: options.prove,
        keyCache: config.sdk.keyCache,
        logLevel: config.sdk.logLevel,
        egressPolicy: connection.egressPolicy,
      });

      dryRunResults.push({
        programId,
        transaction: tx,
        estimatedFee: 0n,
      });
    }

    return { mode: "dry-run", results: dryRunResults };
  }

  // 14. Reconcile: create degraded records for skipped+already-deployed programs with no state.
  // Runs AFTER dry-run check so dry-run never writes deployment state.
  if (manager) {
    for (const outcome of preflightResult.programs) {
      if (outcome.action === "skip" && outcome.reason === "already-deployed" && !outcome.record) {
        // Fetch source for degraded record creation
        const source = await connection.getProgramSource(outcome.programId);
        if (source) {
          const degraded = createDegradedRecord(
            outcome.programId,
            networkName,
            connection.endpoint,
            source,
          );
          await manager.record(degraded, "deploy");
        }
      }
    }
  }

  // 15. Deploy each program in order
  const results: DeployResult[] = [];
  const fee = options.priorityFee ?? config.deploy.defaultPriorityFee;
  const privateFee = config.deploy.privateFee;
  const shouldConfirm = !options.skipConfirm && config.deploy.confirmTransactions;
  const confirmTimeout = config.deploy.confirmationTimeout;

  // Inter-deployment delay for HTTP
  const isHttp = networkConfig.type === "http";
  const interDelay = config.deploy.interDeploymentDelay ?? (isHttp ? 12_000 : 0);

  for (let i = 0; i < toDeployIds.length; i++) {
    const programId = toDeployIds[i]!;
    const prog = programMap.get(programId);
    const leoSources = prog ? readLeoSourcesFromDirImpl(prog.sourceDir) : "";
    const constructor = parseConstructor(leoSources)!;

    const aleoSource = lre.artifacts.getAleoSource(programId);
    if (!aleoSource) {
      throw new DeployError(
        `No compiled .aleo source found for "${programId}". Run \`lionden compile\` first.`,
      );
    }

    const abi = lre.artifacts.getAbi(programId) as ProgramABI | undefined;
    if (!abi) {
      throw new DeployError(
        `No compiled ABI found for "${programId}". ` +
          `Run \`lionden compile\` first, or pass --noCompile only when artifacts already exist.`,
      );
    }
    const abiHash = computeAbiHash(abi);

    // Derive deployer address from connection (prefer namedAccounts.deployer key)
    const deployerAddress = await resolveDeployerAddress(
      connection,
      networkConfig,
      deployerSignerKey,
    );

    // Before broadcast: write pending marker
    if (manager) {
      const pending: PendingDeployment = {
        programId,
        action: "deploy",
        startedAt: new Date().toISOString(),
        expectedEdition: 0,
        deployerAddress: deployerAddress ?? "unknown",
        priorityFee: fee,
        privateFee,
        constructor: {
          type: constructor.type,
          adminAddress: constructor.adminAddress,
          checksumMapping: constructor.checksumMapping,
          checksumKey: constructor.checksumKey,
          fingerprint: extractConstructorFingerprint(aleoSource, constructor.type),
        },
        abiHash,
        network: networkName,
        endpoint: connection.endpoint,
      };
      await manager.setPending(pending);
    }

    // Build and broadcast
    const txId = await deployToNetwork({
      programId,
      aleoSource,
      connection,
      fee,
      privateFee,
      signerPrivateKey: deployerSignerKey,
      prove: options.prove,
      keyCache: config.sdk.keyCache,
      logLevel: config.sdk.logLevel,
      egressPolicy: connection.egressPolicy,
    });

    // Wait for confirmation
    let blockHeight = 0;
    if (shouldConfirm) {
      const confirmed = await connection.waitForConfirmation(txId, confirmTimeout);
      if (confirmed.status === "rejected") {
        throw new DeployError(`Deploy transaction ${txId} was rejected on-chain.`);
      }
      blockHeight = confirmed.blockHeight;
    }

    // Record in deployment state
    if (manager) {
      const record: CompleteDeploymentRecord = {
        status: "complete",
        programId,
        edition: 0,
        constructor: {
          type: constructor.type,
          adminAddress: constructor.adminAddress,
          checksumMapping: constructor.checksumMapping,
          checksumKey: constructor.checksumKey,
          fingerprint: extractConstructorFingerprint(aleoSource, constructor.type),
        },
        abiHash,
        network: networkName,
        endpoint: connection.endpoint,
        updatedAt: new Date().toISOString(),
        historyCount: 1,
        txId,
        blockHeight,
        deployerAddress: deployerAddress ?? "unknown",
        deployedAt: new Date().toISOString(),
        feePaid: fee,
      };
      await manager.record(record, "deploy", { abi });
    }

    const result: DeployResult = {
      programId,
      txId,
      blockHeight,
      constructorType: constructor.type,
    };
    results.push(result);

    console.log(`Deployed ${programId} (tx: ${txId}, block: ${blockHeight})`);

    // Fire deployment hook
    await lre.hooks.serial("deployment", "programDeployed", {
      programId,
      txId,
      blockHeight,
      edition: 0,
      constructorType: constructor.type,
      network: networkName,
    });

    // Inter-deployment delay (HTTP only, between dependent programs only).
    // The next program may only need the propagation time if it imports from
    // a program just deployed. Unrelated programs in the same batch skip the wait.
    if (isHttp && interDelay > 0 && i < toDeployIds.length - 1) {
      const nextProgramId = toDeployIds[i + 1]!;
      const nextImports = graph.imports.get(nextProgramId) ?? [];
      const deployedSoFar = toDeployIds.slice(0, i + 1);
      const nextDependsOnDeployed = nextImports.some((dep) => deployedSoFar.includes(dep));
      if (nextDependsOnDeployed) {
        await sleep(interDelay);
      }
    }
  }

  // 16. Export if requested
  if (manager && (options.export || config.deploy.autoExport)) {
    await manager.export(networkName);
  }

  return { mode: "deploy", results };
}

// ---------------------------------------------------------------------------
// Deploy target resolution
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
  const normalized = targetProgram.endsWith(".aleo") ? targetProgram : `${targetProgram}.aleo`;

  if (!compiledIds.includes(normalized)) {
    throw new DeployError(
      `Program "${targetProgram}" not found. ` + `Available: ${compiledIds.join(", ") || "none"}`,
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

function collectTransitiveProgramDeps(
  unitId: string,
  graph: DependencyGraph,
  programMap: ReadonlyMap<string, DiscoveredProgram>,
  collected: Set<string>,
  visited: Set<string> = new Set(),
): void {
  if (visited.has(unitId)) return;
  visited.add(unitId);

  if (programMap.has(unitId)) {
    collected.add(unitId);
  }

  const deps = graph.imports.get(unitId) ?? [];
  for (const dep of deps) {
    if (graph.networkDeps.has(dep)) continue;
    collectTransitiveProgramDeps(dep, graph, programMap, collected, visited);
  }
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

/**
 * Validate the constructor annotation. Per ARC-0006:
 * - ALL deployments MUST have a constructor — hard error if missing
 * - @admin addresses must be valid Aleo addresses
 * - @checksum must specify a mapping reference and key
 * - @custom triggers a warning about on-chain evaluation
 */
export function validateConstructor(constructor: ConstructorInfo | null, programId: string): void {
  if (!constructor) {
    throw new DeployError(
      `Program "${programId}" has no constructor annotation.\n\n` +
        `Per ARC-0006, all deployments require a constructor. ` +
        `Add one of the following to your program:\n\n` +
        `  @noupgrade\n` +
        `  constructor() { ... }\n\n` +
        `  @admin(address="aleo1...")\n` +
        `  constructor() { ... }\n\n` +
        `  @checksum(mapping="prog.aleo::map_name", key="value")\n` +
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

  if (constructor.type === "checksum") {
    if (!constructor.checksumMapping) {
      throw new DeployError(
        `Program "${programId}" has @checksum constructor but no mapping specified.\n` +
          `Usage: @checksum(mapping="prog.aleo::map_name", key="value")`,
      );
    }
    if (!constructor.checksumKey) {
      throw new DeployError(
        `Program "${programId}" has @checksum constructor but no key specified.\n` +
          `Usage: @checksum(mapping="prog.aleo::map_name", key="value")`,
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
// Transaction building — split for dry-run support
// ---------------------------------------------------------------------------

interface BuildDeployOptions {
  programId: string;
  aleoSource: string;
  connection: NetworkConnection;
  fee: number;
  privateFee: boolean;
  /** Override the signing key. When set, overrides connection.privateKey. */
  signerPrivateKey?: string;
  /** Use the standard SDK deployment builder instead of the devnode fast-path. */
  prove?: boolean;
  /** Resolved SDK key-cache config from `lre.config.sdk.keyCache`. */
  keyCache?: ResolvedSdkKeyCacheConfig;
  /** Resolved SDK log level from `lre.config.sdk.logLevel`. */
  logLevel?: SdkLogLevel;
  /** Egress policy from `connection.egressPolicy`. */
  egressPolicy: SdkEgressPolicy;
}

/**
 * Build a deployment transaction without broadcasting.
 * Only supported on devnode (HTTP deploy() is atomic).
 */
export async function buildDeployTransaction(opts: BuildDeployOptions): Promise<unknown> {
  if (opts.connection.type !== "devnode") {
    throw new DeployError(
      `Dry-run is not supported for HTTP networks in v1. ` +
        `Use --preflight for validation without deployment.`,
    );
  }

  const { createSdkObjects, checkDevnodeSdkSupport, initConsensusHeights } = await import(
    "@lionden/network"
  );

  await initConsensusHeights();
  if (!opts.prove) {
    await checkDevnodeSdkSupport();
  }

  const sdk = await createSdkObjects({
    network: opts.connection.networkId,
    endpoint: opts.connection.endpoint,
    privateKey: opts.signerPrivateKey ?? opts.connection.privateKey,
    apiKey: opts.connection.apiKey,
    keyCache: opts.keyCache,
    logLevel: opts.logLevel,
    egressPolicy: opts.egressPolicy,
  });

  return buildDevnodeDeploymentTransactionForMode(sdk.programManager, opts);
}

type DeploymentProgramManager = {
  buildDevnodeDeploymentTransaction(options: {
    program: string;
    priorityFee: number;
    privateFee: boolean;
  }): Promise<unknown>;
  buildDeploymentTransaction?: (
    program: string,
    priorityFee: number,
    privateFee: boolean,
  ) => Promise<unknown>;
};

async function buildDevnodeDeploymentTransactionForMode(
  programManager: DeploymentProgramManager,
  opts: BuildDeployOptions,
): Promise<unknown> {
  if (opts.prove === true) {
    if (typeof programManager.buildDeploymentTransaction !== "function") {
      throw new DeployError(
        `Unable to deploy "${opts.programId}" with the standard deployment builder: ` +
          `the installed @provablehq/sdk does not expose buildDeploymentTransaction().`,
      );
    }
    return programManager.buildDeploymentTransaction(opts.aleoSource, opts.fee, opts.privateFee);
  }

  return programManager.buildDevnodeDeploymentTransaction({
    program: opts.aleoSource,
    priorityFee: opts.fee,
    privateFee: opts.privateFee,
  });
}

/**
 * Full deploy: build and broadcast. Returns transaction ID.
 */
async function deployToNetwork(opts: BuildDeployOptions): Promise<string> {
  const { aleoSource, connection, fee, privateFee } = opts;

  const { createSdkObjects, checkDevnodeSdkSupport, initConsensusHeights } = await import(
    "@lionden/network"
  );

  const signerKey = opts.signerPrivateKey ?? connection.privateKey;

  if (connection.type === "devnode") {
    await initConsensusHeights();
    if (!opts.prove) {
      await checkDevnodeSdkSupport();
    }

    const sdk = await createSdkObjects({
      network: connection.networkId,
      endpoint: connection.endpoint,
      privateKey: signerKey,
      apiKey: connection.apiKey,
      keyCache: opts.keyCache,
      logLevel: opts.logLevel,
      egressPolicy: opts.egressPolicy,
    });

    const tx = await buildDevnodeDeploymentTransactionForMode(sdk.programManager, opts);

    return connection.broadcastTransaction(tx);
  }

  // HTTP: atomic build+broadcast
  const sdk = await createSdkObjects({
    network: connection.networkId,
    endpoint: connection.endpoint,
    privateKey: signerKey,
    apiKey: connection.apiKey,
    keyCache: opts.keyCache,
    logLevel: opts.logLevel,
    egressPolicy: opts.egressPolicy,
  });

  return sdk.programManager.deploy(aleoSource, fee, privateFee);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { DeployError } from "./errors.js";
export { readLeoSourcesFromDir } from "./leo-sources.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the deployer's address from the network config or connection.
 * Best-effort — returns undefined if derivation fails.
 */
async function resolveDeployerAddress(
  connection: NetworkConnection,
  networkConfig: ResolvedNetworkConfig,
  signerPrivateKey?: string,
): Promise<string | undefined> {
  const privateKey =
    signerPrivateKey ??
    connection.privateKey ??
    (networkConfig.type === "devnode" && networkConfig.accounts.length > 0
      ? networkConfig.accounts[0]!.privateKey
      : undefined);

  if (!privateKey) return undefined;

  try {
    const { createSdkObjects } = await import("@lionden/network");
    const sdk = await createSdkObjects({
      network: connection.networkId,
      endpoint: connection.endpoint,
      privateKey,
      egressPolicy: connection.egressPolicy,
    });
    const account = sdk.account as any;
    return typeof account.address === "function"
      ? account.address().to_string()
      : String(account.address ?? account);
  } catch {
    return undefined;
  }
}
