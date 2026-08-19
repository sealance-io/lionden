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

import type { DeployProvider, ResolvedNetworkConfig } from "@lionden/config";
import { isSignable } from "@lionden/config";
import {
  KeyArtifactsMetadataError,
  type LionDenRuntimeEnvironment,
  logAction,
  logMetadata,
  logSuccess,
  readProgramArtifactProvenance,
} from "@lionden/core";
import {
  type DiscoveredProgram,
  discoverUnits,
  type ProgramABI,
  resolveDependencies,
} from "@lionden/leo-compiler";
import type { NetworkManager } from "@lionden/network";
import {
  buildBackendContext,
  buildPreflightContext,
  resolveDeployBackend,
} from "./deploy-backend/resolve.js";
import { resolveDeployBackendOption } from "./deploy-backend/select.js";
import type { DeployBackendRequest } from "./deploy-backend/types.js";
import { resolveDeployerAddress } from "./deployer-address.js";
import { collectLocalDeploymentClosure } from "./deployment-closure.js";
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
  /**
   * Backend that builds this upgrade's transactions. The highest-precedence
   * layer of the selection ladder — outranks `--deploy-backend`,
   * `LIONDEN_DEPLOY_BACKEND`, `networks.<n>.deployBackend`, and
   * `deploy.backend`. See `resolveDeployBackendOption`.
   */
  deployBackend?: DeployProvider;
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
    // Narrowed by resolveDeployBackendOption below, which reads the same key —
    // it rejects an unrecognized value rather than trusting this cast.
    deployBackend: args["deployBackend"] as DeployProvider | undefined,
  };

  const config = lre.config;
  const manager = lre.deployments as DeploymentManager | null;

  // Normalize program ID
  const programId = options.program.endsWith(".aleo") ? options.program : `${options.program}.aleo`;

  // 0. Resolve the deploy backend and prove it can run, before connecting. A
  // backend that cannot run must fail here rather than after a full compile.
  const networkName = options.network ?? config.defaultNetwork;
  const backendPreflightCtx = buildPreflightContext(config, networkName);
  const backendProvider = resolveDeployBackendOption(args, lre, networkName);
  const backend = resolveDeployBackend(backendProvider, backendPreflightCtx);
  await backend.preflight(backendPreflightCtx);

  // 1. Connect to network
  console.log(`${logAction("Upgrading")} ${programId} on network "${networkName}"`);
  const networkManager = lre.network as NetworkManager;
  const connection = await networkManager.connect(networkName);
  const backendCtx = buildBackendContext(config, connection, networkName);

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

  // 4b. Resolve the local dependency closure. `leo upgrade` upgrades a package's
  // entire local closure by default, so a backend that drives it must name every
  // dependency in `--skip` to narrow the run to one program — lionden owns
  // ordering, pending markers and records per program. The SDK backend ignores
  // this field; it upgrades exactly the source it is handed.
  const localDependencyIds = collectUpgradeDependencyIds(config.paths.programs, sourceProgramId);

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
    // Present by construction: `buildPreflightContext` already rejected an
    // unknown network name above.
    config.networks[networkName] as ResolvedNetworkConfig,
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
  const built = await backend.buildUpgrade(
    buildUpgradeRequest({
      programId,
      ...(rename ? { sourceProgramId } : {}),
      aleoSource,
      localDependencyIds,
      fee,
      privateFee: config.deploy.privateFee,
      ...(adminSignerKey !== undefined ? { signerPrivateKey: adminSignerKey } : {}),
      ...(options.prove !== undefined ? { prove: options.prove } : {}),
    }),
    backendCtx,
  );
  const txId =
    built.kind === "broadcast"
      ? built.txId
      : await connection.broadcastTransaction(built.transaction);
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

interface BuildUpgradeRequestOptions {
  programId: string;
  /** Canonical local source id when the upgrade target was renamed. */
  sourceProgramId?: string;
  aleoSource: string;
  /** Local dependency ids, already excluding the source program id. */
  localDependencyIds: readonly string[];
  fee: number;
  privateFee: boolean;
  /** Override signing key. When set, overrides `ctx.privateKey`. */
  signerPrivateKey?: string;
  /** Build a standard/proven transaction instead of the devnode fast-path. */
  prove?: boolean;
}

/** Assemble a backend request for an upgrade. */
function buildUpgradeRequest(opts: BuildUpgradeRequestOptions): DeployBackendRequest {
  return {
    programId: opts.programId,
    ...(opts.sourceProgramId !== undefined ? { sourceProgramId: opts.sourceProgramId } : {}),
    aleoSource: opts.aleoSource,
    localDependencyIds: opts.localDependencyIds,
    priorityFee: opts.fee,
    privateFee: opts.privateFee,
    ...(opts.signerPrivateKey !== undefined ? { signerPrivateKey: opts.signerPrivateKey } : {}),
    prove: opts.prove === true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Local dependency ids in the upgrade target's closure, excluding the target.
 *
 * `upgradeAction` keeps no dependency graph — it upgrades one already-deployed
 * program — so the graph is rebuilt here from the same source tree the compile
 * step just consumed, rather than threading a second traversal through the task.
 *
 * **`rootId` is the source program id, and it is also what gets subtracted.**
 * That is what makes rename safe. The closure is traversed over the source
 * graph, where the post-rename id is not a node, so it never appears in the
 * result; subtracting the post-rename id instead would be a no-op and leave the
 * source id in the skip list. Leo matches `--skip` by substring, so
 * `--skip hello.aleo` also suppresses `renamed_hello.aleo` — the very program
 * being upgraded — and the run would exit 0 having built nothing.
 */
function collectUpgradeDependencyIds(programsDir: string, rootId: string): string[] {
  const discovered = discoverUnits(programsDir);
  const programMap = new Map(
    discovered
      .filter((u): u is DiscoveredProgram => u.kind === "program")
      .map((p) => [p.programId, p]),
  );
  const graph = resolveDependencies(discovered);

  return collectLocalDeploymentClosure(rootId, graph, programMap).filter((id) => id !== rootId);
}

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
