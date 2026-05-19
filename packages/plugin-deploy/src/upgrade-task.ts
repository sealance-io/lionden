/**
 * Upgrade task implementation.
 *
 * Uses DeploymentManager (lre.deployments) for all state.
 * Order: connect → recover → read state → validate → compile → preflight → broadcast → record.
 *
 * No fallback to the old deploy-manifest.ts system.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { ResolvedSdkKeyCacheConfig } from "@lionden/config";
import { isSignable } from "@lionden/config";
import type { ProgramABI } from "@lionden/leo-compiler";
import {
  discoverUnits,
  parseAbi,
  type DiscoveredProgram,
} from "@lionden/leo-compiler";
import type {
  NetworkManager,
  NetworkConnection,
  SdkEgressPolicy,
} from "@lionden/network";
import type { CompleteDeploymentRecord, DeploymentRecord, PendingDeployment } from "./deployment-types.js";
import type { DeploymentManager } from "./deployment-manager.js";
import { readAbiSnapshot } from "./deployment-state.js";
import {
  parseConstructor,
  extractConstructorFingerprint,
  type ConstructorInfo,
} from "./constructor-parser.js";
import { checkAbiCompatibility, type AbiViolation } from "./abi-compat.js";
import { DeployError } from "./errors.js";
import { readLeoSourcesFromDir } from "./leo-sources.js";
import { runUpgradePreflight } from "./preflight.js";
import { validateAdminSigner } from "./admin-signer.js";
import { declaresStaticRecords } from "./aleo-source.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  /** Program to upgrade (required) */
  program: string;
  /** Priority fee in microcredits */
  priorityFee?: number;
  /** Skip waiting for transaction confirmation */
  skipConfirm?: boolean;
  /** Target network (overrides defaultNetwork) */
  network?: string;
  /** Build a standard/proven transaction even on devnode. */
  prove?: boolean;
}

export interface UpgradeResult {
  readonly programId: string;
  readonly txId: string;
  readonly blockHeight: number;
  readonly newEdition: number;
}

// ---------------------------------------------------------------------------
// Upgrade action
// ---------------------------------------------------------------------------

export async function upgradeAction(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
): Promise<UpgradeResult> {
  const programArg = args["program"] as string | undefined;
  if (!programArg) {
    throw new DeployError(
      "The --program option is required for upgrade. " +
        "Usage: lionden upgrade --program <name>",
    );
  }

  const options: UpgradeOptions = {
    program: programArg,
    priorityFee: args["priorityFee"] as number | undefined,
    skipConfirm: args["skipConfirm"] as boolean | undefined,
    network: args["network"] as string | undefined,
    prove: resolveProveOption(args, lre),
  };

  const config = lre.config;
  const artifactsDir = config.paths.artifacts;
  const programsDir = config.paths.programs;
  const deploymentsDir = config.paths.deployments;
  const manager = lre.deployments as DeploymentManager | null;

  // Normalize program ID
  const programId = options.program.endsWith(".aleo")
    ? options.program
    : `${options.program}.aleo`;

  // 1. Connect to network
  const networkName = options.network ?? config.defaultNetwork;
  const networkManager = lre.network as NetworkManager;
  const connection = await networkManager.connect(networkName);

  // 1b. Resolve admin signer from namedAccounts (if configured)
  let adminSignerKey: string | undefined;
  let namedAdminAddress: string | undefined;
  const namedAdmin = lre.namedAccounts["admin"];
  if (namedAdmin !== undefined) {
    if (isSignable(namedAdmin)) {
      adminSignerKey = namedAdmin.privateKey;
    } else {
      // Address-only admin — used for drift warning in preflight
      namedAdminAddress = namedAdmin.address;
    }
  }

  // 2. Recover pending deployments from previous runs
  if (manager) {
    await manager.recoverPendingDeployments(networkName, connection);
  }

  // 3. Read existing deployment state
  let existingRecord: DeploymentRecord | null = null;
  if (manager) {
    existingRecord = await manager.getDeployment(programId, networkName);
  }

  if (!existingRecord) {
    throw new DeployError(
      `No deployment record found for "${programId}". ` +
        `Deploy the program first with \`lionden deploy --program ${options.program}\`.`,
    );
  }

  // 4. Record-status-aware setup
  // For degraded/recovered records with null constructor type, derive from local Leo sources
  // and build an effective record with the local constructor merged in so that permission
  // and immutability checks can enforce it.
  let effectiveRecord: DeploymentRecord = existingRecord;
  if (!existingRecord.constructor.type) {
    const discovered = discoverUnits(programsDir);
    const programs = discovered.filter((u): u is DiscoveredProgram => u.kind === "program");
    const prog = programs.find((p) => p.programId === programId);
    const leoSources = prog ? readLeoSourcesFromDir(prog.sourceDir) : "";
    const localConstructor = parseConstructor(leoSources);

    if (!localConstructor) {
      throw new DeployError(
        `Upgrade validation requires either a prior complete deployment record or ` +
          `local compilation artifacts. Program "${programId}" has a degraded deployment ` +
          `record (detected on-chain without full provenance) and no local Leo sources with ` +
          `a constructor annotation. Compile the program locally first, or perform a fresh deploy.`,
      );
    }
    // Synthesize an effective record with the locally-derived constructor for validation.
    // The original existingRecord is unchanged (we keep it for recording purposes later).
    effectiveRecord = {
      ...existingRecord,
      constructor: {
        type: localConstructor.type,
        adminAddress: localConstructor.adminAddress,
        checksumMapping: localConstructor.checksumMapping,
        checksumKey: localConstructor.checksumKey,
      },
    } as DeploymentRecord;
  }

  // 5. Read old ABI — disk snapshot for non-ephemeral, memory cache for ephemeral, then artifacts
  const oldAbi =
    (manager && !manager.isEphemeral(networkName)
      ? readAbiSnapshot(deploymentsDir, networkName, programId)
      : null) ??
    manager?.getCachedAbi(programId, networkName) ??
    readAbiFromArtifacts(artifactsDir, programId);

  if (!oldAbi) {
    throw new DeployError(
      `No ABI found for "${programId}". ` +
        `Expected at deployments/${networkName}/${programId}.abi.json ` +
        `or artifacts/${programId}/abi.json. ` +
        `Cannot verify upgrade compatibility without the deployed ABI. ` +
        `Re-compile the deployed version first, or re-deploy.`,
    );
  }

  // 6. Compile the updated program
  await lre.tasks.run("compile", { program: options.program });

  // 7. Read new ABI from compilation artifacts
  const newAbi = lre.artifacts.getAbi(programId) as ProgramABI | undefined;
  if (!newAbi) {
    throw new DeployError(
      `No compiled ABI found for "${programId}". Compilation may have failed.`,
    );
  }

  // 8. Read compiled Aleo source
  const aleoSource = lre.artifacts.getAleoSource(programId);
  if (!aleoSource) {
    throw new DeployError(
      `No compiled .aleo source found for "${programId}".`,
    );
  }

  // 9. Discover Leo source directory for constructor parsing
  const discovered = discoverUnits(programsDir);
  const programs = discovered.filter((u): u is DiscoveredProgram => u.kind === "program");
  const prog = programs.find((p) => p.programId === programId);
  const leoSources = prog ? readLeoSourcesFromDir(prog.sourceDir) : "";

  const newConstructor = parseConstructor(leoSources);
  if (!newConstructor) {
    throw new DeployError(
      `Updated program "${programId}" has no constructor annotation. ` +
        `ARC-0006 requires a constructor for all deployments/upgrades.`,
    );
  }

  const newFingerprint = extractConstructorFingerprint(aleoSource, newConstructor.type);

  // 10. Check upgrade permission (noupgrade → immediate error)
  // Uses effectiveRecord so degraded/recovered records with a locally-derived constructor type
  // are subject to the same @noupgrade enforcement as complete records.
  validateUpgradePermission(effectiveRecord, programId);

  // 11. Run upgrade pre-flight (ABI compat, constructor immutability, admin signer, edition check)
  const preflightResult = await runUpgradePreflight({
    programId,
    oldRecord: effectiveRecord,
    oldAbi,
    newConstructor,
    newAbi,
    newFingerprint,
    connection,
    config,
    networkName,
    signerPrivateKey: adminSignerKey,
    namedAdminAddress,
  });

  if (!preflightResult.passed) {
    const errorMessages = preflightResult.errors
      .map((e) => `  [${e.code}] ${e.message}`)
      .join("\n");
    // Use UpgradeCompatibilityError when the only failures are ABI violations
    const onlyAbiErrors = preflightResult.errors.every((e) => e.code === "ABI_INCOMPATIBLE");
    if (onlyAbiErrors) {
      const violations: AbiViolation[] = preflightResult.errors.flatMap((e) => {
        // Re-run compat to extract typed violations for UpgradeCompatibilityError
        const compat = checkAbiCompatibility(oldAbi, newAbi);
        return [...compat.violations];
      });
      throw new UpgradeCompatibilityError(programId, violations);
    }
    throw new DeployError(`Upgrade pre-flight failed:\n${errorMessages}`);
  }

  // Log any warnings
  for (const w of preflightResult.warnings) {
    console.warn(`Warning [${w.code}]: ${w.message}`);
  }

  // 11. Set pending marker before broadcast
  const previousEdition = existingRecord.edition;
  const newEdition = previousEdition + 1;
  const newAbiHash = computeAbiHash(newAbi);
  const deployerAddress = await resolveDeployerAddress(connection, config, networkName, adminSignerKey);

  if (manager) {
    const pending: PendingDeployment = {
      programId,
      action: "upgrade",
      startedAt: new Date().toISOString(),
      expectedEdition: newEdition,
      deployerAddress: deployerAddress ?? "unknown",
      priorityFee: options.priorityFee ?? config.deploy.defaultPriorityFee,
      privateFee: config.deploy.privateFee,
      constructor: {
        type: newConstructor.type,
        adminAddress: newConstructor.adminAddress,
        checksumMapping: newConstructor.checksumMapping,
        checksumKey: newConstructor.checksumKey,
        fingerprint: newFingerprint,
      },
      abiHash: newAbiHash,
      network: networkName,
      endpoint: connection.endpoint,
    };
    await manager.setPending(pending);
  }

  // 12. Build and broadcast upgrade transaction
  const fee = options.priorityFee ?? config.deploy.defaultPriorityFee;

  const txId = await buildAndBroadcastUpgrade({
    programId,
    aleoSource,
    connection,
    fee,
    privateFee: config.deploy.privateFee,
    edition: newEdition,
    signerPrivateKey: adminSignerKey,
    prove: options.prove,
    keyCache: config.sdk.keyCache,
    egressPolicy: connection.egressPolicy,
  });

  // 13. Wait for confirmation
  let blockHeight = 0;
  const shouldConfirm = !options.skipConfirm && config.deploy.confirmTransactions;
  if (shouldConfirm) {
    const confirmed = await connection.waitForConfirmation(
      txId,
      config.deploy.confirmationTimeout,
    );
    if (confirmed.status === "rejected") {
      throw new DeployError(
        `Upgrade transaction ${txId} was rejected on-chain.`,
      );
    }
    blockHeight = confirmed.blockHeight;
  }

  // 14. Compute ABI changes for history
  const abiChanges = computeAbiChanges(oldAbi, newAbi);

  // 15. Record in deployment state (promotes degraded/recovered to complete)
  if (manager) {
    const oldDeployerAddress =
      existingRecord.status === "complete" || existingRecord.status === "recovered"
        ? existingRecord.deployerAddress
        : "unknown";

    const updatedRecord: CompleteDeploymentRecord = {
      status: "complete",
      programId,
      edition: newEdition,
      constructor: {
        type: newConstructor.type,
        adminAddress: newConstructor.adminAddress,
        checksumMapping: newConstructor.checksumMapping,
        checksumKey: newConstructor.checksumKey,
        fingerprint: newFingerprint,
      },
      abiHash: newAbiHash,
      network: networkName,
      endpoint: connection.endpoint,
      updatedAt: new Date().toISOString(),
      historyCount: existingRecord.historyCount + 1,
      txId,
      blockHeight,
      deployerAddress: deployerAddress ?? oldDeployerAddress,
      deployedAt: new Date().toISOString(),
      feePaid: fee,
    };

    await manager.record(updatedRecord, "upgrade", {
      abi: newAbi,
      historyEntry: {
        previousEdition,
        ...(abiChanges ? { abiChanges } : {}),
      },
    });
  }

  console.log(
    `Upgraded ${programId} to edition ${newEdition} (tx: ${txId}, block: ${blockHeight})`,
  );

  // 16. Fire upgrade hook
  await lre.hooks.serial("deployment", "programUpgraded", {
    programId,
    txId,
    blockHeight,
    edition: newEdition,
    constructorType: newConstructor.type,
    network: networkName,
    previousEdition,
  });

  // 17. Export if autoExport
  if (manager && config.deploy.autoExport) {
    await manager.export(networkName);
  }

  return { programId, txId, blockHeight, newEdition };
}

// ---------------------------------------------------------------------------
// Upgrade permission (still exported for external use)
// ---------------------------------------------------------------------------

/**
 * Check that the existing deployment's constructor permits upgrade.
 * @deprecated Use runUpgradePreflight() — it now includes this check.
 */
export function validateUpgradePermission(
  record: DeploymentRecord,
  programId: string,
): void {
  const type = record.constructor.type;

  switch (type) {
    case "noupgrade":
      throw new DeployError(
        `Program "${programId}" was deployed with @noupgrade and cannot be upgraded.`,
      );
    case "admin":
    case "checksum":
    case "custom":
      break;
    case null:
      // Degraded record — constructor type unknown, proceed and let preflight validate
      break;
    default:
      throw new DeployError(
        `Program "${programId}" has unknown constructor type "${type}". ` +
          `Cannot determine upgrade eligibility.`,
      );
  }
}

// Re-export for backward compatibility
export { validateAdminSigner } from "./admin-signer.js";

// ---------------------------------------------------------------------------
// ABI compatibility error
// ---------------------------------------------------------------------------

export class UpgradeCompatibilityError extends DeployError {
  readonly violations: readonly AbiViolation[];

  constructor(programId: string, violations: readonly AbiViolation[]) {
    const details = violations
      .map((v) => `  - [${v.kind}] ${v.detail}`)
      .join("\n");
    super(
      `Upgrade of "${programId}" is not ABI-compatible with the deployed version:\n${details}`,
    );
    this.name = "UpgradeCompatibilityError";
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Transaction building
// ---------------------------------------------------------------------------

interface BuildUpgradeOptions {
  programId: string;
  aleoSource: string;
  connection: NetworkConnection;
  fee: number;
  privateFee: boolean;
  edition: number;
  /** Override signing key. When set, overrides connection.privateKey. */
  signerPrivateKey?: string;
  /** Use the standard SDK upgrade builder instead of the devnode fast-path. */
  prove?: boolean;
  /** Resolved SDK key-cache config from `lre.config.sdk.keyCache`. */
  keyCache?: ResolvedSdkKeyCacheConfig;
  /** Egress policy from `connection.egressPolicy`. */
  egressPolicy: SdkEgressPolicy;
}

async function buildAndBroadcastUpgrade(
  opts: BuildUpgradeOptions,
): Promise<string> {
  const { programId, aleoSource, connection, fee, privateFee, edition, signerPrivateKey } = opts;

  const { createSdkObjects, checkDevnodeSdkSupport, initConsensusHeights } =
    await import("@lionden/network");

  const needsStandardBuilder = needsStandardUpgradeBuilder(opts);

  if (connection.type === "devnode") {
    await initConsensusHeights();
    if (!needsStandardBuilder) {
      await checkDevnodeSdkSupport();
    }
  }

  const sdk = await createSdkObjects({
    network: connection.networkId,
    endpoint: connection.endpoint,
    privateKey: signerPrivateKey ?? connection.privateKey,
    apiKey: connection.apiKey,
    keyCache: opts.keyCache,
    egressPolicy: opts.egressPolicy,
  });

  if (connection.type === "devnode" && !needsStandardBuilder) {
    const tx = await sdk.programManager.buildDevnodeUpgradeTransaction({
      program: aleoSource,
      priorityFee: fee,
      privateFee,
    });

    return connection.broadcastTransaction(tx);
  }

  // Standard upgrade — use buildUpgradeTransaction + manual broadcast
  const pm = sdk.programManager as any;
  if (typeof pm.buildUpgradeTransaction === "function") {
    const tx = await pm.buildUpgradeTransaction({
      program: aleoSource,
      priorityFee: fee,
      privateFee,
    });
    return connection.broadcastTransaction(tx);
  }

  if (connection.type === "devnode" && needsStandardBuilder) {
    throw new DeployError(
      `Unable to upgrade "${programId}" with the standard upgrade builder: ` +
        `the installed @provablehq/sdk does not expose buildUpgradeTransaction().`,
    );
  }

  // Fallback: try legacy upgrade() if available on older SDK versions
  if (typeof pm.upgrade === "function") {
    return pm.upgrade(aleoSource, fee, edition);
  }

  throw new DeployError(
    `Unable to upgrade "${programId}": no suitable upgrade method found on ProgramManager. ` +
      `Ensure @provablehq/sdk@^0.10.5 is installed.`,
  );
}

function needsStandardUpgradeBuilder(opts: BuildUpgradeOptions): boolean {
  return opts.prove === true || declaresStaticRecords(opts.aleoSource);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveProveOption(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
): boolean {
  const explicit = args["prove"];
  if (typeof explicit === "boolean") return explicit;

  if (lre.globalOptions["prove"] === true) return true;

  return process.env["LIONDEN_PROVE"] === "true";
}

function readAbiFromArtifacts(
  artifactsDir: string,
  programId: string,
): ProgramABI | null {
  const abiPath = path.join(artifactsDir, programId, "abi.json");
  if (!fs.existsSync(abiPath)) return null;
  const raw = fs.readFileSync(abiPath, "utf-8");
  return parseAbi(raw);
}

function computeAbiHash(abi: ProgramABI): string {
  return crypto.createHash("sha256").update(JSON.stringify(abi)).digest("hex");
}

async function resolveDeployerAddress(
  connection: NetworkConnection,
  config: import("@lionden/config").LionDenResolvedConfig,
  networkName: string,
  signerPrivateKey?: string,
): Promise<string | undefined> {
  const networkConfig = config.networks[networkName];
  if (!networkConfig) return undefined;

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

function computeAbiChanges(
  oldAbi: ProgramABI,
  newAbi: ProgramABI,
): {
  added: {
    mappings: string[];
    structs: string[];
    records: string[];
    transitions: string[];
  };
} | undefined {
  const oldMappingNames = new Set(oldAbi.mappings.map((m) => m.name));
  const oldStructPaths = new Set(oldAbi.structs.map((s) => s.path.join("::")));
  const oldRecordPaths = new Set(oldAbi.records.map((r) => r.path.join("::")));
  const oldTransitionNames = new Set(oldAbi.transitions.map((t) => t.name));

  const added = {
    mappings: newAbi.mappings.map((m) => m.name).filter((n) => !oldMappingNames.has(n)),
    structs: newAbi.structs.map((s) => s.path.join("::")).filter((p) => !oldStructPaths.has(p)),
    records: newAbi.records.map((r) => r.path.join("::")).filter((p) => !oldRecordPaths.has(p)),
    transitions: newAbi.transitions.map((t) => t.name).filter((n) => !oldTransitionNames.has(n)),
  };

  const hasChanges =
    added.mappings.length > 0 ||
    added.structs.length > 0 ||
    added.records.length > 0 ||
    added.transitions.length > 0;

  return hasChanges ? { added } : undefined;
}
