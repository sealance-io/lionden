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
 * The backend (Leo vs standalone) is resolved up front so a missing standalone
 * binary surfaces as a clear error before spawning.
 */
export async function startDevnode(
  config?: LionDenResolvedConfig,
  overrides?: DevnodeStartOptions,
): Promise<ManagedDevnode> {
  const manager = new DevnodeManager();

  // Build options from config + overrides
  const devnodeConfig = config ? findDevnodeNetworkConfig(config) : undefined;

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
 * Prefers the default network if it is a devnode, otherwise falls back
 * to the first devnode found in the networks map.
 */
function findDevnodeNetworkConfig(config: LionDenResolvedConfig):
  | {
      autoBlock?: boolean;
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
    network: net.network,
    privateKey: net.privateKey,
    leoBinary: config.leoBinary,
    consensusHeights: net.consensusHeights,
    provider: net.provider,
    binary: net.binary,
    storagePath: net.storagePath,
    clearStorage: net.clearStorageOnStart,
  });

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
