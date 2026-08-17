/**
 * Deploy-backend resolution and context construction.
 *
 * Mirrors the shape of `resolveDevnodeBackend` / `preflightDevnode` in
 * `@lionden/network`: an explicit resolve step that can reject an unusable
 * combination up front, and a separate preflight that proves the backend can
 * actually run.
 *
 * Only the SDK backend exists today. Provider selection (config, per-network
 * override, `--deploy-backend`, `LIONDEN_DEPLOY_BACKEND`) and the compatibility
 * assertions land with the Leo backend.
 */

import type { LionDenResolvedConfig } from "@lionden/config";
import type { NetworkConnection } from "@lionden/network";
import { createSdkDeployBackend } from "./sdk-backend.js";
import type {
  DeployBackend,
  DeployBackendContext,
  DeployBackendPreflightContext,
} from "./types.js";

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
    ...(config.sdk.keyCache !== undefined ? { keyCache: config.sdk.keyCache } : {}),
    ...(config.sdk.logLevel !== undefined ? { logLevel: config.sdk.logLevel } : {}),
  };
}

/**
 * Resolve the deploy backend for this invocation.
 *
 * `connectionType` is load-bearing beyond mere reporting: it decides
 * `capabilities.buildWithoutBroadcast`, which is what gates `--dry-run`.
 */
export function resolveDeployBackend(ctx: DeployBackendPreflightContext): DeployBackend {
  return createSdkDeployBackend(ctx.connectionType);
}
