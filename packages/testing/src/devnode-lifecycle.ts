/**
 * Devnode lifecycle management for test suites.
 *
 * Provides helpers to auto-start a devnode in beforeAll and stop it
 * in afterAll, matching the plan's suite-level isolation model.
 */

import { DevnodeManager } from "@lionden/network";
import type { DevnodeStartOptions } from "@lionden/network";
import type { LionDenResolvedConfig } from "@lionden/config";

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
 */
export async function startDevnode(
  config?: LionDenResolvedConfig,
  overrides?: DevnodeStartOptions,
): Promise<ManagedDevnode> {
  const manager = new DevnodeManager();

  // Build options from config + overrides
  const devnodeConfig = config
    ? findDevnodeNetworkConfig(config)
    : undefined;

  const options: DevnodeStartOptions = {
    autoBlock: devnodeConfig?.autoBlock ?? true,
    network: devnodeConfig?.network ?? "testnet",
    leoBinary: devnodeConfig?.leoBinary,
    consensusHeights: devnodeConfig?.consensusHeights,
    ...overrides,
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
function findDevnodeNetworkConfig(
  config: LionDenResolvedConfig,
): {
  autoBlock?: boolean;
  network?: "testnet" | "mainnet" | "canary";
  privateKey?: string;
  leoBinary?: string;
  consensusHeights?: string;
} | undefined {
  // Prefer the default network
  const defaultNet = config.networks[config.defaultNetwork];
  if (defaultNet?.type === "devnode") {
    return {
      autoBlock: defaultNet.autoBlock,
      network: defaultNet.network,
      privateKey: defaultNet.privateKey,
      leoBinary: config.leoBinary,
      consensusHeights: defaultNet.consensusHeights,
    };
  }

  // Fallback: first devnode in the config
  for (const net of Object.values(config.networks)) {
    if (net.type === "devnode") {
      return {
        autoBlock: net.autoBlock,
        network: net.network,
        privateKey: net.privateKey,
        leoBinary: config.leoBinary,
        consensusHeights: net.consensusHeights,
      };
    }
  }
  return undefined;
}
