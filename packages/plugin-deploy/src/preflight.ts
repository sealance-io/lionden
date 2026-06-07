/**
 * Pre-flight validation pipeline.
 *
 * Pure validation — never writes state. Returns structured results with
 * per-program outcomes for deploy, and pass/fail with errors/warnings for
 * upgrade.
 */

import type {
  LionDenResolvedConfig,
  ResolvedNetworkConfig,
  ResolvedSdkKeyCacheConfig,
  SdkLogLevel,
} from "@lionden/config";
import type { DependencyGraph, ProgramABI } from "@lionden/leo-compiler";
import type { NetworkConnection } from "@lionden/network";
import { checkAbiCompatibility } from "./abi-compat.js";
import { validateAdminSigner } from "./admin-signer.js";
import type { ConstructorInfo } from "./constructor-parser.js";
import { isValidAleoAddress } from "./constructor-parser.js";
import type { DeploymentRecord } from "./deployment-types.js";
import { DeployError } from "./errors.js";
import { checkProgramOnChain, fetchImportSources } from "./on-chain-check.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PreflightWarning {
  readonly code: string;
  readonly message: string;
}

export interface PreflightError {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface ProgramPreflightOutcome {
  readonly programId: string;
  readonly action: "deploy" | "skip";
  readonly reason?: "already-deployed" | "already-in-state";
  readonly record?: DeploymentRecord;
  readonly feeEstimate?: bigint;
}

export interface DeployPreflightResult {
  readonly passed: boolean;
  readonly warnings: PreflightWarning[];
  readonly errors: PreflightError[];
  readonly programs: ProgramPreflightOutcome[];
  readonly totalFeeEstimate?: bigint;
}

export interface UpgradePreflightResult {
  readonly passed: boolean;
  readonly warnings: PreflightWarning[];
  readonly errors: PreflightError[];
  readonly feeEstimate?: bigint;
}

// ---------------------------------------------------------------------------
// Individual checks — deploy
// ---------------------------------------------------------------------------

/**
 * Check that the constructor is present and valid.
 * Returns an error if missing or invalid.
 */
export function checkConstructorPresent(
  constructor: ConstructorInfo | null,
  programId: string,
): PreflightError | null {
  if (!constructor) {
    return {
      code: "NO_CONSTRUCTOR",
      message:
        `Program "${programId}" has no constructor annotation. ` +
        `Per ARC-0006, all deployments require a constructor.`,
      recoverable: false,
    };
  }
  return null;
}

/**
 * Check that the constructor annotation is fully valid (address format, etc.).
 * Delegates to validateConstructor, converting DeployError to PreflightError.
 */
export function checkConstructorValid(
  constructor: ConstructorInfo | null,
  programId: string,
): PreflightError | null {
  if (!constructor) return null; // already caught by checkConstructorPresent

  try {
    if (constructor.type === "admin") {
      if (!constructor.adminAddress) {
        throw new DeployError(
          `Program "${programId}" has @admin constructor but no address specified. ` +
            `Usage: @admin(address="aleo1...")`,
        );
      }
      if (!isValidAleoAddress(constructor.adminAddress)) {
        throw new DeployError(
          `Program "${programId}" has @admin constructor with invalid address: ` +
            `"${constructor.adminAddress}". ` +
            `Aleo addresses must start with "aleo1" and be 63 characters long.`,
        );
      }
    }
    if (constructor.type === "checksum") {
      if (!constructor.checksumMapping) {
        throw new DeployError(
          `Program "${programId}" has @checksum constructor but no mapping specified. ` +
            `Usage: @checksum(mapping="prog.aleo::map_name", key="value")`,
        );
      }
      if (!constructor.checksumKey) {
        throw new DeployError(
          `Program "${programId}" has @checksum constructor but no key specified. ` +
            `Usage: @checksum(mapping="prog.aleo::map_name", key="value")`,
        );
      }
    }
    return null;
  } catch (err: unknown) {
    return {
      code: "INVALID_CONSTRUCTOR",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    };
  }
}

/**
 * Check whether a program is already deployed on-chain.
 *
 * - If on-chain and skipDeployed=true → action: "skip"
 * - If on-chain and skipDeployed=false → fatal error
 * - If not on-chain → action: "deploy"
 */
export async function checkAlreadyDeployed(
  connection: NetworkConnection,
  programId: string,
  existingRecord: DeploymentRecord | null,
  skipDeployed: boolean,
): Promise<{ outcome: ProgramPreflightOutcome; error: PreflightError | null }> {
  // For devnode: always validate via getProgramSource (memory-first policy)
  // For HTTP: also check on-chain existence
  const { exists } = await checkProgramOnChain(connection, programId);

  if (!exists) {
    return {
      outcome: { programId, action: "deploy" },
      error: null,
    };
  }

  // Program exists on-chain
  if (!skipDeployed) {
    return {
      outcome: {
        programId,
        action: "skip",
        reason: "already-deployed",
        record: existingRecord ?? undefined,
      },
      error: {
        code: "ALREADY_DEPLOYED",
        message:
          `Program "${programId}" is already deployed on-chain and ` +
          `--no-skip-deployed was specified. Remove the flag to skip it.`,
        recoverable: false,
      },
    };
  }

  return {
    outcome: {
      programId,
      action: "skip",
      reason: existingRecord ? "already-in-state" : "already-deployed",
      record: existingRecord ?? undefined,
    },
    error: null,
  };
}

/**
 * Check that all imports of a program are available — either already on-chain
 * or scheduled for deployment earlier in the same run.
 *
 * HTTP only (devnode skips — imports are guaranteed by local compilation).
 */
export async function checkImportsAvailable(
  connection: NetworkConnection,
  graph: DependencyGraph,
  programId: string,
  deployTargets: Set<string>,
  localSources: Map<string, string>,
): Promise<PreflightError[]> {
  const errors: PreflightError[] = [];

  const imports = graph.imports.get(programId) ?? [];

  for (const importId of imports) {
    // Check if scheduled for deployment earlier in this run
    if (deployTargets.has(importId)) continue;

    // Check if we have the source locally (local dep not yet on-chain in this batch)
    if (localSources.has(importId)) continue;

    // Check if on-chain
    const { exists } = await checkProgramOnChain(connection, importId);
    if (!exists) {
      errors.push({
        code: "MISSING_IMPORT",
        message:
          `Program "${programId}" imports "${importId}" which is not deployed on-chain ` +
          `and not scheduled for deployment in this run.`,
        recoverable: false,
      });
    }
  }

  return errors;
}

/**
 * Estimate the deployment fee for a program.
 * Returns the estimate in microcredits, or undefined if estimation fails.
 * HTTP only (devnode skips proof generation so fee estimation is not meaningful).
 */
export async function checkFeeEstimate(
  connection: NetworkConnection,
  programId: string,
  aleoSource: string,
  importSources: Map<string, string>,
  signerPrivateKey?: string,
  keyCache?: ResolvedSdkKeyCacheConfig,
  logLevel?: SdkLogLevel,
): Promise<{ estimate: bigint | undefined; warning: PreflightWarning | null }> {
  try {
    const { createSdkObjects } = await import("@lionden/network");
    const sdk = await createSdkObjects({
      network: connection.networkId,
      endpoint: connection.endpoint,
      privateKey: signerPrivateKey ?? connection.privateKey,
      apiKey: connection.apiKey,
      egressPolicy: connection.egressPolicy,
      keyCache,
      logLevel,
    });
    const pm = sdk.programManager as any;

    if (typeof pm.estimateDeploymentFee !== "function") {
      return {
        estimate: undefined,
        warning: {
          code: "FEE_ESTIMATION_UNAVAILABLE",
          message: `Fee estimation not available in this SDK version. Cannot estimate deployment cost for "${programId}".`,
        },
      };
    }

    // Build imports object for SDK
    const importsObj: Record<string, string> = {};
    for (const [id, src] of importSources) {
      importsObj[id] = src;
    }

    const estimatedFee: number | bigint = await pm.estimateDeploymentFee(
      aleoSource,
      Object.keys(importsObj).length > 0 ? importsObj : undefined,
    );

    return {
      estimate: BigInt(estimatedFee),
      warning: null,
    };
  } catch (err: unknown) {
    return {
      estimate: undefined,
      warning: {
        code: "FEE_ESTIMATION_FAILED",
        message: `Failed to estimate deployment fee for "${programId}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Check that the deployer's balance is sufficient to cover estimated fees.
 * Warns if balance < 1.5x total estimate, errors if < 1x.
 * HTTP only.
 */
export async function checkBalanceSufficient(
  connection: NetworkConnection,
  totalEstimate: bigint,
  signerAddress?: string,
): Promise<{ warning: PreflightWarning | null; error: PreflightError | null }> {
  if (totalEstimate === 0n) {
    return { warning: null, error: null };
  }

  const balance = await connection.getBalance(signerAddress);
  const bufferThreshold = (totalEstimate * 3n) / 2n; // 1.5x

  if (balance < totalEstimate) {
    return {
      warning: null,
      error: {
        code: "INSUFFICIENT_BALANCE",
        message:
          `Deployer balance (${balance} microcredits) is less than the estimated total fee ` +
          `(${totalEstimate} microcredits). Deployment will likely fail.`,
        recoverable: false,
      },
    };
  }

  if (balance < bufferThreshold) {
    return {
      warning: {
        code: "LOW_BALANCE",
        message:
          `Deployer balance (${balance} microcredits) is less than 1.5x the estimated total fee ` +
          `(${totalEstimate} microcredits). Consider adding more credits to cover fees.`,
      },
      error: null,
    };
  }

  return { warning: null, error: null };
}

// ---------------------------------------------------------------------------
// Individual checks — upgrade
// ---------------------------------------------------------------------------

/**
 * Check ABI compatibility between deployed and new version.
 */
export function checkAbiCompatible(
  oldAbi: ProgramABI,
  newAbi: ProgramABI,
  programId: string,
): PreflightError | null {
  const compat = checkAbiCompatibility(oldAbi, newAbi);
  if (!compat.compatible) {
    const details = compat.violations.map((v) => `  - [${v.kind}] ${v.detail}`).join("\n");
    return {
      code: "ABI_INCOMPATIBLE",
      message: `Upgrade of "${programId}" is not ABI-compatible with the deployed version:\n${details}`,
      recoverable: false,
    };
  }
  return null;
}

/**
 * Check that the constructor hasn't changed (immutable after first deployment).
 */
export function checkConstructorImmutable(
  oldRecord: DeploymentRecord,
  newConstructor: ConstructorInfo,
  newFingerprint: string,
  programId: string,
): PreflightError | null {
  const oldType = oldRecord.constructor.type;
  const oldFingerprint = oldRecord.constructor.fingerprint;
  const oldAdmin = oldRecord.constructor.adminAddress;

  if (oldType && newConstructor.type !== oldType) {
    return {
      code: "CONSTRUCTOR_TYPE_CHANGED",
      message:
        `Program "${programId}" constructor type changed from "${oldType}" to ` +
        `"${newConstructor.type}". Constructors are immutable after first deployment.`,
      recoverable: false,
    };
  }

  if (newConstructor.type === "admin" && oldAdmin && newConstructor.adminAddress !== oldAdmin) {
    return {
      code: "CONSTRUCTOR_ADMIN_CHANGED",
      message:
        `Program "${programId}" @admin address changed from "${oldAdmin}" to ` +
        `"${newConstructor.adminAddress}". Constructor admin address is immutable after first deployment.`,
      recoverable: false,
    };
  }

  // Check @checksum parameters
  const oldChecksumMapping = oldRecord.constructor.checksumMapping;
  const oldChecksumKey = oldRecord.constructor.checksumKey;
  if (
    newConstructor.type === "checksum" &&
    (oldChecksumMapping || oldChecksumKey) &&
    (newConstructor.checksumMapping !== oldChecksumMapping ||
      newConstructor.checksumKey !== oldChecksumKey)
  ) {
    return {
      code: "CONSTRUCTOR_CHECKSUM_CHANGED",
      message:
        `Program "${programId}" @checksum parameters changed. ` +
        `Constructor parameters are immutable after first deployment.`,
      recoverable: false,
    };
  }

  if (oldFingerprint !== undefined && newFingerprint !== oldFingerprint) {
    return {
      code: "CONSTRUCTOR_BODY_CHANGED",
      message:
        `Program "${programId}" constructor body changed between versions. ` +
        `Constructors are immutable after first deployment.`,
      recoverable: false,
    };
  }

  return null;
}

/**
 * Check that the admin signer address matches the @admin constructor address.
 * Delegates to validateAdminSigner, converting DeployError to PreflightError.
 *
 * Returns { warning, error } where:
 * - warning: NAMED_ADMIN_DRIFT when address-only namedAccounts.admin drifts from @admin(address)
 * - error: ADMIN_SIGNER_MISMATCH when the actual transaction signer is not the admin
 *
 * The drift warning is additive: it fires when namedAdminAddress differs from adminAddress,
 * but signer validation still runs independently unless signerPrivateKey is provided
 * (in which case signerPrivateKey IS the selected signer and covers both).
 */
export async function checkAdminSigner(
  connection: NetworkConnection,
  config: LionDenResolvedConfig,
  networkName: string,
  record: DeploymentRecord,
  programId: string,
  signerPrivateKey?: string,
  namedAdminAddress?: string,
): Promise<{ warning: PreflightWarning | null; error: PreflightError | null }> {
  if (record.constructor.type !== "admin" || !record.constructor.adminAddress) {
    return { warning: null, error: null };
  }

  const adminAddress = record.constructor.adminAddress!;

  // Drift check: when an address-only named admin is provided (no private key),
  // warn if it doesn't match the program's @admin address.
  // This is purely additive — signer validation still runs below.
  let driftWarning: PreflightWarning | null = null;
  if (!signerPrivateKey && namedAdminAddress && namedAdminAddress !== adminAddress) {
    driftWarning = {
      code: "NAMED_ADMIN_DRIFT",
      message:
        `Named account "admin" address "${namedAdminAddress}" does not match ` +
        `@admin(address="${adminAddress}") in program "${programId}". ` +
        `Update your namedAccounts config or the program constructor.`,
    };
  }

  // Signer validation: always run. When signerPrivateKey is provided, validateAdminSigner
  // derives its address and checks against adminAddress — same path as network-config signer,
  // just using the named account's key instead.
  try {
    await validateAdminSigner(
      connection,
      config,
      networkName,
      adminAddress,
      programId,
      signerPrivateKey,
    );
    return { warning: driftWarning, error: null };
  } catch (err: unknown) {
    return {
      warning: driftWarning,
      error: {
        code: "ADMIN_SIGNER_MISMATCH",
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      },
    };
  }
}

/**
 * Check that the on-chain edition matches the expected edition.
 * HTTP only — ensures no out-of-band upgrades happened since last sync.
 */
export async function checkEditionContinuity(
  connection: NetworkConnection,
  programId: string,
  expectedEdition: number,
): Promise<PreflightError | null> {
  const { exists, edition: onChainEdition } = await checkProgramOnChain(connection, programId);
  if (!exists) {
    return {
      code: "PROGRAM_NOT_FOUND",
      message: `Program "${programId}" is not deployed on-chain. Cannot upgrade a program that isn't deployed.`,
      recoverable: false,
    };
  }
  if (onChainEdition === null) {
    return null;
  }
  if (onChainEdition !== expectedEdition) {
    return {
      code: "EDITION_MISMATCH",
      message:
        `Program "${programId}" on-chain edition is ${onChainEdition} but expected ${expectedEdition}. ` +
        `The program may have been upgraded out-of-band.`,
      recoverable: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pipeline runners
// ---------------------------------------------------------------------------

export interface RunDeployPreflightOptions {
  programs: Array<{
    programId: string;
    constructor: ConstructorInfo | null;
    aleoSource: string | undefined;
    existingRecord: DeploymentRecord | null;
  }>;
  connection: NetworkConnection;
  networkConfig: ResolvedNetworkConfig;
  config: LionDenResolvedConfig;
  skipDeployed: boolean;
  /** All program IDs being deployed in this run (for import availability checks) */
  deployTargets: Set<string>;
  /** Compiled Aleo sources for local deps not yet on-chain (programId → source) */
  localSources: Map<string, string>;
  /** Dependency graph for import checks */
  graph: DependencyGraph;
  /** Override signing key for fee estimation and balance checks. When set, overrides connection.privateKey. */
  signerPrivateKey?: string;
}

/**
 * Run pre-flight validation for a set of programs to be deployed.
 * Pure — never writes state.
 */
export async function runDeployPreflight(
  opts: RunDeployPreflightOptions,
): Promise<DeployPreflightResult> {
  const {
    programs,
    connection,
    networkConfig,
    skipDeployed,
    deployTargets,
    localSources,
    graph,
    signerPrivateKey,
  } = opts;

  const isDevnode = networkConfig.type === "devnode";
  const warnings: PreflightWarning[] = [];
  const errors: PreflightError[] = [];
  const outcomes: ProgramPreflightOutcome[] = [];

  // Track which programs in this batch are confirmed to deploy
  // (used as "known to deploy" for import checks of later programs)
  const confirmedDeployTargets = new Set<string>(deployTargets);

  let totalFeeEstimate: bigint | undefined;

  for (const prog of programs) {
    const { programId, constructor, aleoSource, existingRecord } = prog;

    // 1. Check constructor present
    const noCtorErr = checkConstructorPresent(constructor, programId);
    if (noCtorErr) {
      errors.push(noCtorErr);
      outcomes.push({ programId, action: "deploy" });
      continue;
    }

    // 2. Check constructor valid
    const ctorErr = checkConstructorValid(constructor, programId);
    if (ctorErr) {
      errors.push(ctorErr);
      outcomes.push({ programId, action: "deploy" });
      continue;
    }

    // 3. Check if already deployed
    const { outcome: deployedOutcome, error: deployedErr } = await checkAlreadyDeployed(
      connection,
      programId,
      existingRecord,
      skipDeployed,
    );

    if (deployedErr) {
      errors.push(deployedErr);
      outcomes.push(deployedOutcome);
      continue;
    }

    if (deployedOutcome.action === "skip") {
      outcomes.push(deployedOutcome);
      // Do NOT add to confirmedDeployTargets — it's being skipped
      confirmedDeployTargets.delete(programId);
      continue;
    }

    // This program will be deployed — run HTTP-only checks
    if (!isDevnode) {
      // 3.5. Check compiled artifacts present (HTTP only — needed for import/fee checks)
      if (aleoSource === undefined) {
        errors.push({
          code: "MISSING_ARTIFACTS",
          message:
            `No compiled .aleo source found for "${programId}". ` +
            `Run \`lionden compile\` before running preflight.`,
          recoverable: false,
        });
        outcomes.push({ programId, action: "deploy" });
        continue;
      }

      // 4. Check imports available
      if (aleoSource !== undefined) {
        const importErrors = await checkImportsAvailable(
          connection,
          graph,
          programId,
          confirmedDeployTargets,
          localSources,
        );
        errors.push(...importErrors);
        if (importErrors.length > 0) {
          outcomes.push({ programId, action: "deploy" });
          continue;
        }
      }

      // 5. Fee estimation
      if (aleoSource !== undefined) {
        // Collect import sources for fee estimation.
        // Local sources (deps in this batch) are known; all other imports (including
        // credits.aleo and other external programs) are fetched from on-chain.
        const importIds = graph.imports.get(programId) ?? [];
        const importSourcesForFee = new Map<string, string>();
        const onChainImportIds: string[] = [];
        for (const id of importIds) {
          const local = localSources.get(id);
          if (local) {
            importSourcesForFee.set(id, local);
          } else {
            onChainImportIds.push(id);
          }
        }
        if (onChainImportIds.length > 0) {
          const fetched = await fetchImportSources(connection, onChainImportIds);
          for (const [id, src] of fetched) {
            importSourcesForFee.set(id, src);
          }
        }

        const { estimate, warning: feeWarning } = await checkFeeEstimate(
          connection,
          programId,
          aleoSource,
          importSourcesForFee,
          signerPrivateKey,
          opts.config.sdk.keyCache,
          opts.config.sdk.logLevel,
        );
        if (feeWarning) warnings.push(feeWarning);

        if (estimate !== undefined) {
          totalFeeEstimate = (totalFeeEstimate ?? 0n) + estimate;
        }

        outcomes.push({ programId, action: "deploy", feeEstimate: estimate });
      } else {
        outcomes.push({ programId, action: "deploy" });
      }
    } else {
      outcomes.push({ programId, action: "deploy" });
    }
  }

  // 6. Balance check (HTTP only, batch)
  if (!isDevnode && totalFeeEstimate !== undefined && totalFeeEstimate > 0n) {
    // Derive signer address if a signer key override is provided
    let signerAddress: string | undefined;
    if (signerPrivateKey) {
      try {
        const { createSdkObjects } = await import("@lionden/network");
        const sdk = await createSdkObjects({
          network: connection.networkId,
          endpoint: connection.endpoint,
          privateKey: signerPrivateKey,
          apiKey: connection.apiKey,
          egressPolicy: connection.egressPolicy,
          logLevel: opts.config.sdk.logLevel,
        });
        const account = sdk.account as any;
        signerAddress =
          typeof account.address === "function"
            ? account.address().to_string()
            : String(account.address ?? account);
      } catch {
        // Best-effort; fall back to connection default
      }
    }
    const { warning: balanceWarning, error: balanceError } = await checkBalanceSufficient(
      connection,
      totalFeeEstimate,
      signerAddress,
    );
    if (balanceWarning) warnings.push(balanceWarning);
    if (balanceError) errors.push(balanceError);
  }

  return {
    passed: errors.length === 0,
    warnings,
    errors,
    programs: outcomes,
    totalFeeEstimate,
  };
}

export interface RunUpgradePreflightOptions {
  programId: string;
  oldRecord: DeploymentRecord;
  oldAbi: ProgramABI;
  newConstructor: ConstructorInfo;
  newAbi: ProgramABI;
  newFingerprint: string;
  connection: NetworkConnection;
  config: LionDenResolvedConfig;
  networkName: string;
  /** Override signing key for admin validation. When set, overrides the key derived from network config. */
  signerPrivateKey?: string;
  /**
   * Address of an address-only named admin account.
   * When present (and signerPrivateKey is absent), checked against @admin(address) for drift warning.
   */
  namedAdminAddress?: string;
}

/**
 * Run pre-flight validation for an upgrade.
 * Pure — never writes state.
 */
export async function runUpgradePreflight(
  opts: RunUpgradePreflightOptions,
): Promise<UpgradePreflightResult> {
  const {
    programId,
    oldRecord,
    oldAbi,
    newConstructor,
    newAbi,
    newFingerprint,
    connection,
    config,
    networkName,
    signerPrivateKey,
    namedAdminAddress,
  } = opts;

  const isDevnode = config.networks[networkName]?.type === "devnode";
  const warnings: PreflightWarning[] = [];
  const errors: PreflightError[] = [];

  // 1. ABI compatibility
  const abiErr = checkAbiCompatible(oldAbi, newAbi, programId);
  if (abiErr) errors.push(abiErr);

  // 2. Constructor immutability
  const ctorErr = checkConstructorImmutable(oldRecord, newConstructor, newFingerprint, programId);
  if (ctorErr) errors.push(ctorErr);

  // 3. Admin signer (if applicable)
  const { warning: adminDriftWarning, error: signerErr } = await checkAdminSigner(
    connection,
    config,
    networkName,
    oldRecord,
    programId,
    signerPrivateKey,
    namedAdminAddress,
  );
  if (adminDriftWarning) warnings.push(adminDriftWarning);
  if (signerErr) errors.push(signerErr);

  // 4. Edition continuity (HTTP only)
  if (!isDevnode && oldRecord.status === "complete") {
    const editionErr = await checkEditionContinuity(connection, programId, oldRecord.edition);
    if (editionErr) errors.push(editionErr);
  }

  // Custom constructor warning
  if (newConstructor.type === "custom") {
    warnings.push({
      code: "CUSTOM_CONSTRUCTOR",
      message:
        `Program "${programId}" uses @custom constructor. ` +
        `Custom constructor logic will be evaluated on-chain during upgrade.`,
    });
  }

  return {
    passed: errors.length === 0,
    warnings,
    errors,
  };
}
