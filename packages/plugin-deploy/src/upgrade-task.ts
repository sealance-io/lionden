/**
 * Upgrade task implementation (thin).
 *
 * Flow: connect → resolve signer → guard a prior record exists → compile v2 →
 * build upgrade tx → broadcast → wait → record → fire hook → optional export.
 *
 * No ABI-compatibility, constructor-immutability, edition, or admin-address
 * validation — Leo's built-in tooling owns upgrade correctness. The newly
 * compiled ABI is still recorded so `export` has it.
 */

import type { ResolvedSdkKeyCacheConfig, SdkLogLevel } from "@lionden/config";
import { isSignable } from "@lionden/config";
import {
  KeyArtifactsMetadataError,
  type LionDenRuntimeEnvironment,
  logAction,
  logMetadata,
  logSuccess,
  readProgramArtifactProvenance,
} from "@lionden/core";
import type { ProgramABI } from "@lionden/leo-compiler";
import type { NetworkConnection, NetworkManager, SdkEgressPolicy } from "@lionden/network";
import type { DeploymentManager } from "./deployment-manager.js";
import type {
  CompleteDeploymentRecord,
  DeploymentRecord,
  PendingDeployment,
} from "./deployment-types.js";
import { DeployError } from "./errors.js";
import { supportsLeoProgramRename } from "./leo-version.js";
import {
  checkProgramOnChain,
  createDegradedRecord,
  getRequiredProgramEdition,
  waitForProgramEditionAdvance,
} from "./on-chain-check.js";
import { resolveProveOption } from "./prove.js";

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
      "The --program option is required for upgrade. " + "Usage: lionden upgrade --program <name>",
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
  const manager = lre.deployments as DeploymentManager | null;

  // Normalize program ID
  const programId = options.program.endsWith(".aleo") ? options.program : `${options.program}.aleo`;

  // 1. Connect to network
  const networkName = options.network ?? config.defaultNetwork;
  console.log(`${logAction("Upgrading")} ${programId} on network "${networkName}"`);
  const networkManager = lre.network as NetworkManager;
  const connection = await networkManager.connect(networkName);

  // 1b. Resolve admin signer from namedAccounts (selection only — no validation).
  // An address-only "admin" carries no private key, so there is nothing to select.
  let adminSignerKey: string | undefined;
  const namedAdmin = lre.namedAccounts["admin"];
  if (namedAdmin !== undefined && isSignable(namedAdmin)) {
    adminSignerKey = namedAdmin.privateKey;
  }

  // 2. Recover pending deployments from previous runs
  if (manager) {
    await manager.recoverPendingDeployments(networkName, connection);
  }

  // 3. Resolve existing deployment state. When local state is missing, upgrade
  // can still proceed if the target network already has the program.
  let existingRecord: DeploymentRecord | null = null;
  let observedFallbackEdition: number | null = null;
  if (manager) {
    existingRecord = await manager.getDeployment(programId, networkName);
  }

  if (!existingRecord) {
    const onChain = await checkProgramOnChain(connection, programId);
    if (!onChain.exists) {
      throw new DeployError(
        `No deployment record found for "${programId}". ` +
          `Deploy the program first with \`lionden deploy --program ${options.program}\`.`,
      );
    }

    const observedEdition =
      typeof onChain.edition === "number"
        ? onChain.edition
        : await getRequiredProgramEdition(
            connection,
            programId,
            "create degraded deployment record",
          );
    existingRecord = createDegradedRecord(
      programId,
      networkName,
      connection.endpoint,
      onChain.source,
      observedEdition,
    );
    observedFallbackEdition = observedEdition;
  }

  const sourceProgramId = resolveUpgradeSourceProgramId(
    config.paths.artifacts,
    existingRecord,
    programId,
  );
  const rename = sourceProgramId !== programId ? programId : undefined;
  if (rename && !supportsLeoProgramRename(config.leoVersion)) {
    throw new DeployError(
      `upgrade for renamed deployment "${programId}" requires Leo 4.3.0 or newer. ` +
        `Configured leoVersion is "${config.leoVersion}".`,
    );
  }
  if (rename && config.compiler.buildTests) {
    throw new DeployError(
      `upgrade for renamed deployment "${programId}" is not supported when compiler.buildTests is enabled.`,
    );
  }

  // 4. Compile the updated program. Forward the effective upgrade network (when
  // explicitly supplied) so the implicit compile resolves imported on-chain
  // sources + `.env` from the deploying network; omit it otherwise so compile
  // falls back to `config.defaultNetwork` (byte-for-byte unchanged).
  const compileArgs: Record<string, unknown> = rename
    ? { program: sourceProgramId, rename }
    : { program: options.program };
  if (options.network) compileArgs["network"] = options.network;
  await lre.tasks.run("compile", compileArgs);

  // Read the newly-compiled ABI — recorded so `export` has it.
  const newAbi = lre.artifacts.getAbi(programId) as ProgramABI | undefined;
  if (!newAbi) {
    throw new DeployError(`No compiled ABI found for "${programId}". Compilation may have failed.`);
  }

  // 6. Read compiled Aleo source
  const aleoSource = lre.artifacts.getAleoSource(programId);
  if (!aleoSource) {
    throw new DeployError(`No compiled .aleo source found for "${programId}".`);
  }

  // 7. Resolve upgrade provenance before writing a pending marker.
  const deployerAddress = await resolveDeployerAddress(
    connection,
    config,
    networkName,
    adminSignerKey,
  );

  const fee = options.priorityFee ?? config.deploy.defaultPriorityFee;
  const shouldConfirm = !options.skipConfirm && config.deploy.confirmTransactions;
  let previousEdition: number;
  if (observedFallbackEdition !== null) {
    previousEdition = observedFallbackEdition;
  } else if (shouldConfirm) {
    previousEdition = await getRequiredProgramEdition(
      connection,
      programId,
      "read current edition before upgrade",
    );
  } else {
    let liveEdition: number | null = null;
    try {
      liveEdition = await connection.getProgramEdition(programId);
    } catch {
      liveEdition = null;
    }
    if (typeof liveEdition === "number" && Number.isInteger(liveEdition) && liveEdition >= 0) {
      previousEdition = liveEdition;
    } else if (
      typeof existingRecord.edition === "number" &&
      Number.isInteger(existingRecord.edition) &&
      existingRecord.edition >= 0
    ) {
      previousEdition = existingRecord.edition;
    } else {
      throw new Error(
        `Unable to read current edition before upgrade for "${programId}": on-chain program edition could not be observed.`,
      );
    }
  }

  let pending: PendingDeployment | null = null;
  if (manager) {
    pending = {
      programId,
      ...(rename ? { sourceProgramId } : {}),
      action: "upgrade",
      startedAt: new Date().toISOString(),
      deployerAddress: deployerAddress ?? "unknown",
      priorityFee: options.priorityFee ?? config.deploy.defaultPriorityFee,
      privateFee: config.deploy.privateFee,
      network: networkName,
      endpoint: connection.endpoint,
      previousEdition,
    };
    await manager.setPending(pending);
  }

  // 8. Build and broadcast upgrade transaction
  const txId = await buildAndBroadcastUpgrade({
    programId,
    aleoSource,
    connection,
    fee,
    privateFee: config.deploy.privateFee,
    signerPrivateKey: adminSignerKey,
    prove: options.prove,
    keyCache: config.sdk.keyCache,
    logLevel: config.sdk.logLevel,
    egressPolicy: connection.egressPolicy,
  });
  if (manager && pending) {
    pending = { ...pending, txId };
    await manager.setPending(pending);
  }

  // 9. Wait for confirmation
  let blockHeight = 0;
  let edition = previousEdition + 1;
  if (shouldConfirm) {
    console.log(
      `${logAction("Waiting for confirmation")} of ${programId} ${logMetadata(`(tx: ${txId})`)}`,
    );
    const confirmed = await connection.waitForConfirmation(txId, config.deploy.confirmationTimeout);
    if (confirmed.status === "rejected") {
      if (manager) {
        await manager.clearPending(networkName, programId);
      }
      throw new DeployError(`Upgrade transaction ${txId} was rejected on-chain.`);
    }
    blockHeight = confirmed.blockHeight;
    if (manager && pending) {
      pending = { ...pending, txId, blockHeight };
      await manager.setPending(pending);
    }
    edition = await waitForProgramEditionAdvance(
      connection,
      programId,
      previousEdition,
      config.deploy.confirmationTimeout,
    );
  }

  // 10. Record in deployment state (promotes degraded/recovered to complete).
  // The newly-compiled ABI rides along so export consumers have it.
  if (manager) {
    const oldDeployerAddress =
      existingRecord.status === "complete" || existingRecord.status === "recovered"
        ? existingRecord.deployerAddress
        : "unknown";

    const updatedRecord: CompleteDeploymentRecord = {
      status: "complete",
      programId,
      ...(rename ? { sourceProgramId } : {}),
      network: networkName,
      endpoint: connection.endpoint,
      updatedAt: new Date().toISOString(),
      edition,
      historyCount: existingRecord.historyCount + 1,
      txId,
      blockHeight,
      deployerAddress: deployerAddress ?? oldDeployerAddress,
      deployedAt: new Date().toISOString(),
      feePaid: fee,
    };

    await manager.record(updatedRecord, "upgrade", { abi: newAbi });
  }

  console.log(
    `${logSuccess("Upgraded")} ${programId} ${logMetadata(`(tx: ${txId}, block: ${blockHeight})`)}`,
  );

  // 11. Fire upgrade hook
  await lre.hooks.serial("deployment", "programUpgraded", {
    programId,
    txId,
    blockHeight,
    network: networkName,
  });

  // 12. Export if autoExport
  if (manager && config.deploy.autoExport && shouldConfirm) {
    await manager.export(networkName);
  }

  return { programId, txId, blockHeight };
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
  /** Override signing key. When set, overrides connection.privateKey. */
  signerPrivateKey?: string;
  /** Use the standard SDK upgrade builder instead of the devnode fast-path. */
  prove?: boolean;
  /** Resolved SDK key-cache config from `lre.config.sdk.keyCache`. */
  keyCache?: ResolvedSdkKeyCacheConfig;
  /** Resolved SDK log level from `lre.config.sdk.logLevel`. */
  logLevel?: SdkLogLevel;
  /** Egress policy from `connection.egressPolicy`. */
  egressPolicy: SdkEgressPolicy;
}

async function buildAndBroadcastUpgrade(opts: BuildUpgradeOptions): Promise<string> {
  const { programId, aleoSource, connection, fee, privateFee, signerPrivateKey } = opts;

  const { createSdkObjects, captureSdkCall, checkDevnodeSdkSupport, initConsensusHeights } =
    await import("@lionden/network");

  if (connection.type === "devnode") {
    await initConsensusHeights();
    if (!opts.prove) {
      await checkDevnodeSdkSupport();
    }
  }

  const sdk = await createSdkObjects({
    network: connection.networkId,
    endpoint: connection.endpoint,
    privateKey: signerPrivateKey ?? connection.privateKey,
    apiKey: connection.apiKey,
    keyCache: opts.keyCache,
    logLevel: opts.logLevel,
    egressPolicy: opts.egressPolicy,
  });

  if (connection.type === "devnode" && !opts.prove) {
    // Only the build is wrapped; broadcast surfaces its own HTTP error.
    const tx = await captureSdkCall(sdk.diagnostics, { operation: "upgrade", programId }, () =>
      sdk.programManager.buildDevnodeUpgradeTransaction({
        program: aleoSource,
        priorityFee: fee,
        privateFee,
      }),
    );

    return connection.broadcastTransaction(tx);
  }

  // Standard upgrade — use buildUpgradeTransaction + manual broadcast
  const pm = sdk.programManager as any;
  if (typeof pm.buildUpgradeTransaction === "function") {
    const tx = await captureSdkCall(sdk.diagnostics, { operation: "upgrade", programId }, () =>
      pm.buildUpgradeTransaction({
        program: aleoSource,
        priorityFee: fee,
        privateFee,
      }),
    );
    return connection.broadcastTransaction(tx);
  }

  throw new DeployError(
    `Unable to upgrade "${programId}" with the standard upgrade builder: ` +
      `the installed @provablehq/sdk does not expose buildUpgradeTransaction().`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUpgradeSourceProgramId(
  artifactsDir: string,
  existingRecord: DeploymentRecord,
  programId: string,
): string {
  if (existingRecord.sourceProgramId) {
    return existingRecord.sourceProgramId;
  }

  let provenance: ReturnType<typeof readProgramArtifactProvenance>;
  try {
    provenance = readProgramArtifactProvenance(artifactsDir, programId);
  } catch (err) {
    if (err instanceof KeyArtifactsMetadataError) {
      throw new DeployError(
        `Artifact provenance metadata is invalid for upgrade target "${programId}". ` +
          `Recompile the runtime artifact or restore a valid deployment record. Cause: ${err.message}`,
      );
    }
    throw err;
  }

  if (!provenance) {
    return programId;
  }

  if (provenance.programId !== programId) {
    throw new DeployError(
      `Artifact provenance metadata is invalid for upgrade target "${programId}": ` +
        `found programId="${provenance.programId}", sourceProgramId="${provenance.sourceProgramId}".`,
    );
  }

  return provenance.sourceProgramId;
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
