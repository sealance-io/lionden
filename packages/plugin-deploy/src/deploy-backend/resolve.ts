/**
 * Deploy-backend resolution and context construction.
 *
 * Mirrors the shape of `resolveDevnodeBackend` / `preflightDevnode` in
 * `@lionden/network`: an explicit resolve step that can reject an unusable
 * combination up front, and a separate preflight that proves the backend can
 * actually run.
 */

import type { DeployProvider, LionDenResolvedConfig } from "@lionden/config";
import { logWarning } from "@lionden/core";
import type { NetworkConnection } from "@lionden/network";
import { DeployError } from "../errors.js";
import { LEO_DEPLOY_BACKEND_LINE, supportsLeoDeployBackend } from "../leo-version.js";
import { createSdkDeployBackend } from "./sdk-backend.js";
import type {
  DeployBackend,
  DeployBackendContext,
  DeployBackendPreflightContext,
  DeployBackendWarning,
} from "./types.js";

/** Appended to every compatibility rejection — always offer the way out. */
const USE_SDK_HINT = `Use \`--deploy-backend sdk\` (or set \`deploy.backend: "sdk"\`) to keep using the Provable SDK backend.`;

/**
 * Build the context available at step 0, before compilation and before any
 * network connection exists. Everything here comes from resolved config.
 */
export function buildPreflightContext(
  config: LionDenResolvedConfig,
  networkName: string,
): DeployBackendPreflightContext {
  const networkConfig = config.networks[networkName];
  if (!networkConfig) {
    throw new Error(
      `Network "${networkName}" not found in config. ` +
        `Available: ${Object.keys(config.networks).join(", ") || "none"}`,
    );
  }

  return {
    networkName,
    connectionType: networkConfig.type,
    networkId: networkConfig.network,
    // Provisional for devnode: `buildBackendContext` replaces this with the
    // live `connection.endpoint` once a connection exists.
    endpoint:
      networkConfig.type === "devnode"
        ? `http://${networkConfig.socketAddr}`
        : networkConfig.endpoint,
    ...(networkConfig.type === "http" && networkConfig.apiKey !== undefined
      ? { apiKey: networkConfig.apiKey }
      : {}),
    ...(networkConfig.type === "devnode" && networkConfig.consensusHeights !== undefined
      ? { consensusHeights: networkConfig.consensusHeights }
      : {}),
    leoBinary: config.leoBinary,
    leoVersion: config.leoVersion,
    leo: config.deploy.leo,
    ...(config.sdk.egress !== undefined ? { sdkEgress: config.sdk.egress } : {}),
    ...(config.sdk.keyCache !== undefined ? { keyCache: config.sdk.keyCache } : {}),
    ...(config.sdk.logLevel !== undefined ? { logLevel: config.sdk.logLevel } : {}),
    artifactsDir: config.paths.artifacts,
    projectRoot: config.paths.root,
  };
}

/**
 * Extend the preflight context with the connection-derived fields. Must be
 * called after `NetworkManager.connect()` — `egressPolicy` is built
 * per-connection and does not exist before then.
 */
export function buildBackendContext(
  config: LionDenResolvedConfig,
  connection: NetworkConnection,
  networkName: string,
): DeployBackendContext {
  const preflightCtx = buildPreflightContext(config, networkName);
  return {
    ...preflightCtx,
    // Prefer the live connection's values — they are the ones the SDK objects
    // were built from and stay authoritative if the two ever diverge.
    endpoint: connection.endpoint,
    networkId: connection.networkId,
    connectionType: connection.type,
    ...(connection.privateKey !== undefined ? { privateKey: connection.privateKey } : {}),
    ...(connection.apiKey !== undefined ? { apiKey: connection.apiKey } : {}),
    egressPolicy: connection.egressPolicy,
  };
}

/**
 * Reject provider/config combinations that cannot work, and report the ones
 * that merely make a setting inert.
 *
 * Runs against the **effective** provider, not `config.deploy.backend`. That is
 * why this cannot live in `validateResolvedConfig`: config resolution happens
 * before the CLI flag and the environment variable are read, so a Leo backend
 * chosen via `--deploy-backend`, `LIONDEN_DEPLOY_BACKEND`, or a per-network
 * override would slip past it entirely.
 *
 * Mirrors the two-layer split already used for the devnode backend —
 * `plugin-network` validates statically-decidable combinations in its config
 * hook and defers the live probe to start time.
 *
 * Throws on an incompatibility; returns warnings for settings that are simply
 * ignored by the selected backend.
 */
export function assertDeployBackendCompatible(
  provider: DeployProvider,
  ctx: DeployBackendPreflightContext,
): DeployBackendWarning[] {
  if (provider !== "leo") return [];

  const warnings: DeployBackendWarning[] = [];

  // lionden routes every SDK network call through `makeNetworkTransport`
  // specifically so `sdk.egress` can be enforced at the socket. Leo issues its
  // own HTTP requests from a separate process, where that policy cannot reach.
  // Silently dropping a configured egress control is worse than refusing.
  if (ctx.sdkEgress !== undefined) {
    throw new DeployError(
      `The Leo deploy backend cannot honor \`sdk.egress\`. The egress policy is enforced ` +
        `inside the SDK's network transport, which the Leo CLI does not go through — its ` +
        `requests would leave unpoliced. Remove \`sdk.egress\`, or ${USE_SDK_HINT}`,
    );
  }

  // lionden sends `Authorization: Bearer <apiKey>` on its own explorer calls.
  // Leo 4.3 `deploy`/`upgrade` expose no header or API-key option, so its
  // build-time queries would go out unauthenticated — failing outright, or
  // worse, silently reaching an unauthenticated endpoint instead.
  if (ctx.apiKey !== undefined) {
    throw new DeployError(
      `The Leo deploy backend cannot send the \`networks.${ctx.networkName}.apiKey\` credential: ` +
        `Leo ${LEO_DEPLOY_BACKEND_LINE} \`deploy\`/\`upgrade\` expose no API-key or header option, ` +
        `so its queries would be sent unauthenticated. Remove the apiKey, or ${USE_SDK_HINT}`,
    );
  }

  if (!supportsLeoDeployBackend(ctx.leoVersion)) {
    throw new DeployError(
      `The Leo deploy backend supports Leo ${LEO_DEPLOY_BACKEND_LINE}.x only, but \`leoVersion\` ` +
        `is "${ctx.leoVersion}". Other lines differ in their \`deploy\`/\`upgrade\` flag surface ` +
        `and have not been verified for this path. Set \`leoVersion\` to a ${LEO_DEPLOY_BACKEND_LINE}.x ` +
        `release, or ${USE_SDK_HINT}`,
    );
  }

  // Not an error: nothing breaks, the configured cache is just never consulted.
  if (ctx.keyCache?.storage === "filesystem") {
    warnings.push({
      code: "LEO_BACKEND_IGNORES_KEY_CACHE",
      message:
        `\`sdk.keyCache\` is configured for filesystem storage${ctx.keyCache.path ? ` at ${ctx.keyCache.path}` : ""}, ` +
        `but the Leo deploy backend caches synthesized keys under \`~/.aleo\` and will not use it. ` +
        `The setting still applies to program execution.`,
    });
  }

  return warnings;
}

/**
 * Resolve the deploy backend for this invocation.
 *
 * `ctx.connectionType` is load-bearing beyond mere reporting: it decides
 * `capabilities.buildWithoutBroadcast`, which is what gates `--dry-run`.
 */
export function resolveDeployBackend(
  provider: DeployProvider,
  ctx: DeployBackendPreflightContext,
): DeployBackend {
  for (const warning of assertDeployBackendCompatible(provider, ctx)) {
    console.warn(`${logWarning("Warning")} ${warning.message}`);
  }

  if (provider === "leo") {
    // Selection, config resolution, and compatibility validation are all live;
    // only the backend itself is missing. Reached after the checks above so a
    // user who is also misconfigured hears about that first.
    throw new DeployError(
      `The Leo deploy backend is not implemented yet in this version of lionden. ` +
        `${USE_SDK_HINT}`,
    );
  }

  return createSdkDeployBackend(ctx.connectionType);
}
