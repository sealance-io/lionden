/**
 * Devnode lifecycle management for test suites.
 *
 * Provides helpers to auto-start a devnode in beforeAll and stop it
 * in afterAll, matching the plan's suite-level isolation model.
 */

import type { LionDenResolvedConfig } from "@lionden/config";
import type { DevnodeStartOptions } from "@lionden/network";
import { DevnodeManager, preflightDevnode, resolveDevnodeBackend } from "@lionden/network";

/** State of a managed devnode instance. */
export interface ManagedDevnode {
  readonly manager: DevnodeManager;
  readonly endpoint: string;
}

/**
 * Start a devnode for the current test suite.
 *
 * Returns a ManagedDevnode that should be stopped via `stopDevnode()`
 * in the suite teardown (afterAll).
 *
 * The devnode is configured from the resolved config's devnode network
 * settings, or falls back to sensible defaults (auto-block on, testnet).
 * When `networkName` names a devnode network in config, that network's settings
 * are used (so the started devnode matches the one the caller connects to);
 * otherwise the default-then-first devnode is used. The backend (Leo vs
 * standalone) is resolved up front so a missing standalone binary surfaces as a
 * clear error before spawning.
 */
export async function startDevnode(
  config?: LionDenResolvedConfig,
  overrides?: DevnodeStartOptions,
  networkName?: string,
): Promise<ManagedDevnode> {
  const manager = new DevnodeManager();

  // Build options from config + overrides
  const devnodeConfig = config ? findDevnodeNetworkConfig(config, networkName) : undefined;

  const provider = overrides?.provider ?? devnodeConfig?.provider;
  const binary = overrides?.devnodeBinary ?? devnodeConfig?.binary;
  const network = overrides?.network ?? devnodeConfig?.network ?? "testnet";
  const consensusHeights = overrides?.consensusHeights ?? devnodeConfig?.consensusHeights;
  const storagePath = overrides?.storagePath ?? devnodeConfig?.storagePath;
  const clearStorage = overrides?.clearStorage ?? devnodeConfig?.clearStorage;

  const backend = await resolveDevnodeBackend({
    provider,
    leoBinary: devnodeConfig?.leoBinary,
    binary,
    network,
    consensusHeights,
    requiresPersistence: storagePath !== undefined,
  });

  if (config) {
    await preflightDevnode(config, backend);
  }

  const options: DevnodeStartOptions = {
    autoBlock: devnodeConfig?.autoBlock ?? true,
    network,
    leoBinary: devnodeConfig?.leoBinary,
    consensusHeights,
    // Forward the selected devnode's bind/identity settings so the started node
    // matches the one connect() dials. `undefined` lets DevnodeManager keep its
    // own default; an explicit `overrides.*` still wins via the spread below.
    socketAddr: devnodeConfig?.socketAddr,
    verbosity: devnodeConfig?.verbosity,
    genesisPath: devnodeConfig?.genesisPath,
    privateKey: devnodeConfig?.privateKey,
    ...(storagePath !== undefined ? { storagePath } : {}),
    ...(clearStorage ? { clearStorage: true } : {}),
    ...overrides,
    // The resolved backend wins over any stale provider/binary in overrides.
    provider: backend.provider,
    devnodeBinary: backend.command,
  };

  await manager.start(options);

  return {
    manager,
    endpoint: manager.endpoint,
  };
}

/**
 * Stop a managed devnode instance.
 */
export async function stopDevnode(devnode: ManagedDevnode): Promise<void> {
  await devnode.manager.stop();
}

/**
 * Extract devnode network config from resolved config.
 *
 * When `networkName` names a devnode network, that network is used so the
 * started devnode matches the one the caller connects to. Otherwise it prefers
 * the default network if it is a devnode, then falls back to the first devnode
 * found in the networks map (unchanged for callers that pass no name).
 */
function findDevnodeNetworkConfig(
  config: LionDenResolvedConfig,
  networkName?: string,
):
  | {
      autoBlock?: boolean;
      socketAddr?: string;
      verbosity?: number;
      genesisPath?: string;
      network?: "testnet" | "mainnet" | "canary";
      privateKey?: string;
      leoBinary?: string;
      consensusHeights?: string;
      provider?: "leo" | "standalone";
      binary?: string;
      storagePath?: string;
      clearStorage?: boolean;
    }
  | undefined {
  const pick = (net: Extract<LionDenResolvedConfig["networks"][string], { type: "devnode" }>) => ({
    autoBlock: net.autoBlock,
    socketAddr: net.socketAddr,
    verbosity: net.verbosity,
    genesisPath: net.genesisPath,
    network: net.network,
    privateKey: net.privateKey,
    leoBinary: config.leoBinary,
    consensusHeights: net.consensusHeights,
    provider: net.provider,
    binary: net.binary,
    storagePath: net.storagePath,
    clearStorage: net.clearStorageOnStart,
  });

  // Prefer the explicitly selected network when it is a devnode.
  if (networkName !== undefined) {
    const selected = config.networks[networkName];
    if (selected?.type === "devnode") {
      return pick(selected);
    }
  }

  // Prefer the default network
  const defaultNet = config.networks[config.defaultNetwork];
  if (defaultNet?.type === "devnode") {
    return pick(defaultNet);
  }

  // Fallback: first devnode in the config
  for (const net of Object.values(config.networks)) {
    if (net.type === "devnode") {
      return pick(net);
    }
  }
  return undefined;
}
