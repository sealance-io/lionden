/**
 * Pre-flight validation pipeline.
 *
 * Pure validation — never writes state. Returns structured results with
 * per-program outcomes for deploy.
 */

import type {
  LionDenResolvedConfig,
  ResolvedNetworkConfig,
  ResolvedSdkKeyCacheConfig,
  SdkLogLevel,
} from "@lionden/config";
import type { DependencyGraph } from "@lionden/leo-compiler";
import type { NetworkConnection } from "@lionden/network";
import type { DeploymentRecord } from "./deployment-types.js";
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

// ---------------------------------------------------------------------------
// Individual checks — deploy
// ---------------------------------------------------------------------------

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
    const { createSdkObjects, withSuppressedSdkConsoleNoise } = await import("@lionden/network");
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

    const estimatedFee: number | bigint = await withSuppressedSdkConsoleNoise(() =>
      pm.estimateDeploymentFee(
        aleoSource,
        Object.keys(importsObj).length > 0 ? importsObj : undefined,
      ),
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
// Pipeline runners
// ---------------------------------------------------------------------------

export interface RunDeployPreflightOptions {
  programs: Array<{
    programId: string;
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
    const { programId, aleoSource, existingRecord } = prog;

    // 1. Check if already deployed
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
      // 2. Check compiled artifacts present (HTTP only — needed for import/fee checks)
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

      // 3. Check imports available
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

      // 4. Fee estimation
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
  }

  // 5. Balance check (HTTP only, batch)
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
