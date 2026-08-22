/**
 * The deploy/upgrade transaction backend seam.
 *
 * Deploy and upgrade historically bypassed `NetworkConnection` for transaction
 * building, calling `createSdkObjects` directly from seven sites across
 * `deploy-task.ts`, `upgrade-task.ts`, and `preflight.ts`. This module is the
 * single boundary those sites now go through, so an alternative backend (the
 * Leo CLI) can be substituted without touching the surrounding orchestration:
 * dependency ordering, pending markers, deployment records, confirmation
 * polling, hooks, and export are all backend-agnostic and stay where they are.
 *
 * Deliberately free of `plugin-deploy`-specific types (hence
 * `DeployBackendWarning` rather than `PreflightWarning`) so the seam can move to
 * `@lionden/network` unchanged if execution is ever added to its scope.
 */

import type {
  AleoNetwork,
  DeployProvider,
  ResolvedDeployLeoConfig,
  ResolvedSdkEgressConfig,
  ResolvedSdkKeyCacheConfig,
  SdkLogLevel,
} from "@lionden/config";
import type { SdkEgressPolicy } from "@lionden/network";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Which task is resolving a backend.
 *
 * Carried through resolution because support is not uniform across operations:
 * a backend can build deployments and not yet build upgrades. Knowing this at
 * step 0 is what lets `upgradeAction` reject before it connects, compiles, or
 * writes a pending marker.
 */
export type DeployBackendOperation = "deploy" | "upgrade";

/**
 * Everything derivable from config alone, with NO live connection.
 *
 * This is what step 0 of `deployAction` / `upgradeAction` can build, and all
 * that `preflight()` is allowed to read. The split exists because
 * `egressPolicy` is built per-connection by `resolveEgressPolicy`
 * (module-private to `network-manager.ts`) and does not exist until
 * `NetworkManager.connect()` has run — but preflight must be able to reject an
 * unusable backend *before* compilation and before connecting.
 */
export interface DeployBackendPreflightContext {
  /** Network name as it appears in `config.networks`. */
  readonly networkName: string;
  readonly connectionType: "devnode" | "http";
  readonly networkId: AleoNetwork;
  readonly endpoint: string;
  readonly apiKey?: string;
  /** Resolved active-network value. Consumed by the Leo backend only. */
  readonly consensusHeights?: string;
  readonly leoBinary: string;
  readonly leoVersion: string;
  /** Resolved `deploy.leo`. Consumed by the Leo backend only. */
  readonly leo: ResolvedDeployLeoConfig;
  /**
   * User-supplied SDK egress overrides (`config.sdk.egress`), NOT the
   * per-connection runtime policy. Present here because
   * `assertDeployBackendCompatible` must reject a Leo + egress combination at
   * step 0, before any connection exists to carry a policy.
   */
  readonly sdkEgress?: ResolvedSdkEgressConfig;
  readonly keyCache?: ResolvedSdkKeyCacheConfig;
  readonly logLevel?: SdkLogLevel;
  /** Absolute `config.paths.artifacts`. */
  readonly artifactsDir: string;
  /** Absolute `config.paths.root`. */
  readonly projectRoot: string;
}

/**
 * The preflight context plus everything that only exists after `connect()`.
 *
 * Between the two, every field the pre-seam SDK call sites read must be
 * present — see the former `BuildDeployOptions` / `BuildUpgradeOptions` bags and
 * `checkFeeEstimate`'s parameter list.
 *
 * The dividing line is provenance, not convenience: config-derived fields live
 * on the preflight context so `preflight()` and
 * `assertDeployBackendCompatible()` can read them, and only genuinely
 * connection-derived values are added here.
 */
export interface DeployBackendContext extends DeployBackendPreflightContext {
  readonly privateKey?: string;
  /** From `connection.egressPolicy`; built per-connection by the network layer. */
  readonly egressPolicy: SdkEgressPolicy;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * A single program's deploy or upgrade. Deliberately one program per request:
 * lionden owns dependency ordering, writes one pending marker and one record
 * per program, and applies its own inter-deployment delay.
 */
export interface DeployBackendRequest {
  /** Effective (post-rename) on-chain program id. */
  readonly programId: string;
  /** Canonical local source id when this is a renamed deploy/upgrade. */
  readonly sourceProgramId?: string;
  readonly aleoSource: string;
  /**
   * Local programs in this program's dependency closure, excluding the root.
   *
   * Unused by the SDK backend, which deploys exactly the source it is handed.
   * The Leo backend needs it because `leo deploy` deploys a package's entire
   * local dependency closure by default and must be narrowed with `--skip`.
   */
  readonly localDependencyIds: readonly string[];
  readonly priorityFee: number;
  readonly privateFee: boolean;
  /** Overrides `ctx.privateKey` when set. Carries the named deployer/admin role. */
  readonly signerPrivateKey?: string;
  /**
   * Build a standard/proven transaction rather than the devnode fast path.
   * Only meaningful on devnode connections — HTTP always proves.
   */
  readonly prove: boolean;
}

/**
 * Fee estimation. Separate from `DeployBackendRequest` because it needs the
 * resolved import *sources* (which the build path never carries) and none of
 * the fee/prove/dependency fields.
 */
export interface DeployBackendFeeRequest {
  readonly programId: string;
  readonly aleoSource: string;
  readonly importSources: ReadonlyMap<string, string>;
  readonly signerPrivateKey?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Backends either broadcast as part of building, or hand back something
 * broadcastable.
 *
 * Both arms already existed pre-seam: the SDK's HTTP deploy path
 * (`programManager.deploy`) is atomic build+broadcast and yields a txId, while
 * the devnode path and every upgrade path build a transaction that the caller
 * then passes to `connection.broadcastTransaction`.
 *
 * `transaction` stays `unknown` because `AleoNetworkClient.submitTransaction`
 * accepts `Transaction | string` — a WASM handle from the SDK backend, or a
 * serialized transaction JSON string from the Leo backend.
 */
export type DeployBackendResult =
  | { readonly kind: "broadcast"; readonly txId: string }
  | { readonly kind: "built"; readonly transaction: unknown };

/** Package-neutral warning; `preflight.ts` widens this to its `PreflightWarning`. */
export interface DeployBackendWarning {
  readonly code: string;
  readonly message: string;
}

export interface DeployBackendFeeEstimate {
  readonly estimate: bigint | undefined;
  readonly warning: DeployBackendWarning | null;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface DeployBackendCapabilities {
  /**
   * Can produce a transaction without broadcasting it (`--dry-run`).
   *
   * False for the SDK backend on HTTP, where `programManager.deploy` is
   * atomic. This replaces the former hard-coded `connection.type !== "devnode"`
   * check in `deployAction`.
   */
  readonly buildWithoutBroadcast: boolean;
  /** `estimateDeploymentFee` returns a real estimate rather than a warning. */
  readonly feeEstimation: boolean;
  /** Partial key-synthesis progress survives a failed run. */
  readonly resumableKeySynthesis: boolean;
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

export interface DeployBackend {
  readonly provider: DeployProvider;
  readonly capabilities: DeployBackendCapabilities;

  /**
   * Assert this backend can run.
   *
   * MUST be awaited as step 0 of `deployAction` / `upgradeAction` — before
   * compilation and before connecting — so an unusable backend fails fast
   * rather than after a full compile. Takes the *preflight* context because
   * there is no connection yet. Implementations memoize.
   */
  preflight(ctx: DeployBackendPreflightContext): Promise<void>;

  /** Build (and possibly broadcast) a deployment transaction. */
  buildDeploy(req: DeployBackendRequest, ctx: DeployBackendContext): Promise<DeployBackendResult>;

  /** Build (and possibly broadcast) an upgrade transaction. */
  buildUpgrade(req: DeployBackendRequest, ctx: DeployBackendContext): Promise<DeployBackendResult>;

  /**
   * Estimate a deployment fee in microcredits.
   *
   * Returns `{ estimate: undefined, warning }` rather than throwing when the
   * backend cannot estimate — preflight treats a missing estimate as a warning,
   * not a failure.
   */
  estimateDeploymentFee(
    req: DeployBackendFeeRequest,
    ctx: DeployBackendContext,
  ): Promise<DeployBackendFeeEstimate>;
}
