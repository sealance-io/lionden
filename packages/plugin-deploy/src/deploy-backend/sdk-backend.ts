/**
 * The Provable SDK deploy/upgrade backend.
 *
 * This is a faithful relocation of the SDK call sites that previously lived
 * inline in `deploy-task.ts` (`buildDeployTransaction`, `deployToNetwork`,
 * `buildDevnodeDeploymentTransactionForMode`, `resolveDeployerAddress`),
 * `upgrade-task.ts` (`buildAndBroadcastUpgrade`, `resolveDeployerAddress`), and
 * `preflight.ts` (`checkFeeEstimate`, inline signer-address derivation).
 *
 * Behavior is intentionally unchanged, including the asymmetries:
 * - devnode deploy builds a transaction for the caller to broadcast; HTTP
 *   deploy is atomic build+broadcast via `programManager.deploy`.
 * - upgrade is always two-phase on both connection types.
 * - `initConsensusHeights()` / `checkDevnodeSdkSupport()` run for devnode only,
 *   and the support check only when not proving.
 */

import { DeployError } from "../errors.js";
import type {
  DeployBackend,
  DeployBackendCapabilities,
  DeployBackendContext,
  DeployBackendFeeEstimate,
  DeployBackendFeeRequest,
  DeployBackendPreflightContext,
  DeployBackendRequest,
  DeployBackendResult,
} from "./types.js";

/**
 * Structural view of the SDK's ProgramManager. `buildDeploymentTransaction` and
 * `buildUpgradeTransaction` are optional because older SDK builds omit them —
 * absence produces a named error rather than a WASM crash.
 */
type DeploymentProgramManager = {
  deploy(program: string, priorityFee: number, privateFee: boolean): Promise<string>;
  buildDevnodeDeploymentTransaction(options: {
    program: string;
    priorityFee: number;
    privateFee: boolean;
  }): Promise<unknown>;
  buildDevnodeUpgradeTransaction(options: {
    program: string;
    priorityFee: number;
    privateFee: boolean;
  }): Promise<unknown>;
  buildDeploymentTransaction?: (
    program: string,
    priorityFee: number,
    privateFee: boolean,
  ) => Promise<unknown>;
  buildUpgradeTransaction?: (options: {
    program: string;
    priorityFee: number;
    privateFee: boolean;
  }) => Promise<unknown>;
  estimateDeploymentFee?: (
    program: string,
    imports?: Record<string, string>,
  ) => Promise<number | bigint>;
};

function sdkObjectOptions(ctx: DeployBackendContext, privateKey: string | undefined) {
  return {
    network: ctx.networkId,
    endpoint: ctx.endpoint,
    privateKey,
    apiKey: ctx.apiKey,
    keyCache: ctx.keyCache,
    logLevel: ctx.logLevel,
    egressPolicy: ctx.egressPolicy,
  };
}

/** Signer precedence, shared by every operation: per-request override, then connection default. */
function effectiveKey(
  req: { signerPrivateKey?: string },
  ctx: DeployBackendContext,
): string | undefined {
  return req.signerPrivateKey ?? ctx.privateKey;
}

class SdkDeployBackend implements DeployBackend {
  readonly provider = "sdk" as const;
  readonly capabilities: DeployBackendCapabilities;

  constructor(connectionType: "devnode" | "http") {
    this.capabilities = {
      // HTTP deploy goes through `programManager.deploy`, which broadcasts
      // atomically — there is no transaction to hand back.
      buildWithoutBroadcast: connectionType === "devnode",
      feeEstimation: true,
      // Key synthesis happens inside one WASM call that retains everything
      // until it completes; nothing survives a failure.
      resumableKeySynthesis: false,
    };
  }

  /**
   * Load the SDK's WASM runtime and thread pool.
   *
   * `createSdkObjects` does this lazily at the point of use, which means a
   * broken or missing `@provablehq/sdk` install surfaces only *after* a full
   * compile. Doing it here is the fail-fast guarantee step 0 exists for.
   *
   * `initSdk()` memoizes its own promise, so the work happens once per process
   * and the later `createSdkObjects` calls pay nothing.
   */
  async preflight(_ctx: DeployBackendPreflightContext): Promise<void> {
    const { initSdk } = await import("@lionden/network");
    await initSdk();
  }

  async buildDeploy(
    req: DeployBackendRequest,
    ctx: DeployBackendContext,
  ): Promise<DeployBackendResult> {
    const { createSdkObjects, captureSdkCall, checkDevnodeSdkSupport, initConsensusHeights } =
      await import("@lionden/network");

    if (ctx.connectionType === "devnode") {
      await initConsensusHeights();
      if (!req.prove) {
        await checkDevnodeSdkSupport();
      }

      const sdk = await createSdkObjects(sdkObjectOptions(ctx, effectiveKey(req, ctx)));

      // Only the build is wrapped; broadcast surfaces its own HTTP error.
      const transaction = await captureSdkCall(
        sdk.diagnostics,
        { operation: "deploy", programId: req.programId },
        () =>
          buildDeploymentTransactionForMode(sdk.programManager as DeploymentProgramManager, req),
      );

      return { kind: "built", transaction };
    }

    // HTTP: atomic build+broadcast.
    const sdk = await createSdkObjects(sdkObjectOptions(ctx, effectiveKey(req, ctx)));
    const txId = await captureSdkCall(
      sdk.diagnostics,
      { operation: "deploy", programId: req.programId },
      () =>
        (sdk.programManager as DeploymentProgramManager).deploy(
          req.aleoSource,
          req.priorityFee,
          req.privateFee,
        ),
    );

    return { kind: "broadcast", txId };
  }

  async buildUpgrade(
    req: DeployBackendRequest,
    ctx: DeployBackendContext,
  ): Promise<DeployBackendResult> {
    const { createSdkObjects, captureSdkCall, checkDevnodeSdkSupport, initConsensusHeights } =
      await import("@lionden/network");

    if (ctx.connectionType === "devnode") {
      await initConsensusHeights();
      if (!req.prove) {
        await checkDevnodeSdkSupport();
      }
    }

    const sdk = await createSdkObjects(sdkObjectOptions(ctx, effectiveKey(req, ctx)));
    const pm = sdk.programManager as DeploymentProgramManager;
    const buildOptions = {
      program: req.aleoSource,
      priorityFee: req.priorityFee,
      privateFee: req.privateFee,
    };

    if (ctx.connectionType === "devnode" && !req.prove) {
      const transaction = await captureSdkCall(
        sdk.diagnostics,
        { operation: "upgrade", programId: req.programId },
        () => pm.buildDevnodeUpgradeTransaction(buildOptions),
      );
      return { kind: "built", transaction };
    }

    // Standard upgrade — build, then let the caller broadcast.
    if (typeof pm.buildUpgradeTransaction === "function") {
      const build = pm.buildUpgradeTransaction.bind(pm);
      const transaction = await captureSdkCall(
        sdk.diagnostics,
        { operation: "upgrade", programId: req.programId },
        () => build(buildOptions),
      );
      return { kind: "built", transaction };
    }

    throw new DeployError(
      `Unable to upgrade "${req.programId}" with the standard upgrade builder: ` +
        `the installed @provablehq/sdk does not expose buildUpgradeTransaction().`,
    );
  }

  async estimateDeploymentFee(
    req: DeployBackendFeeRequest,
    ctx: DeployBackendContext,
  ): Promise<DeployBackendFeeEstimate> {
    try {
      const { createSdkObjects, withSuppressedSdkConsoleNoise } = await import("@lionden/network");
      const sdk = await createSdkObjects(sdkObjectOptions(ctx, effectiveKey(req, ctx)));
      const pm = sdk.programManager as DeploymentProgramManager;

      if (typeof pm.estimateDeploymentFee !== "function") {
        return {
          estimate: undefined,
          warning: {
            code: "FEE_ESTIMATION_UNAVAILABLE",
            message: `Fee estimation not available in this SDK version. Cannot estimate deployment cost for "${req.programId}".`,
          },
        };
      }
      const estimateFee = pm.estimateDeploymentFee.bind(pm);

      const importsObj: Record<string, string> = {};
      for (const [id, src] of req.importSources) {
        importsObj[id] = src;
      }

      const estimatedFee = await withSuppressedSdkConsoleNoise(() =>
        estimateFee(req.aleoSource, Object.keys(importsObj).length > 0 ? importsObj : undefined),
      );

      return { estimate: BigInt(estimatedFee), warning: null };
    } catch (err: unknown) {
      return {
        estimate: undefined,
        warning: {
          code: "FEE_ESTIMATION_FAILED",
          message: `Failed to estimate deployment fee for "${req.programId}": ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }
}

/**
 * Pick the deployment builder for the requested proving mode.
 *
 * `prove: true` uses the standard builder (real certificates and verifying
 * keys); anything else uses the devnode fast path, which skips proof
 * generation. Only reachable on devnode connections.
 */
async function buildDeploymentTransactionForMode(
  programManager: DeploymentProgramManager,
  req: DeployBackendRequest,
): Promise<unknown> {
  if (req.prove === true) {
    if (typeof programManager.buildDeploymentTransaction !== "function") {
      throw new DeployError(
        `Unable to deploy "${req.programId}" with the standard deployment builder: ` +
          `the installed @provablehq/sdk does not expose buildDeploymentTransaction().`,
      );
    }
    return programManager.buildDeploymentTransaction(
      req.aleoSource,
      req.priorityFee,
      req.privateFee,
    );
  }

  return programManager.buildDevnodeDeploymentTransaction({
    program: req.aleoSource,
    priorityFee: req.priorityFee,
    privateFee: req.privateFee,
  });
}

export function createSdkDeployBackend(connectionType: "devnode" | "http"): DeployBackend {
  return new SdkDeployBackend(connectionType);
}
