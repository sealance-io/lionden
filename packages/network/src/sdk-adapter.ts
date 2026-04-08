/**
 * SDK adapter — isolates the @provablehq/sdk initialization ceremony.
 *
 * The Provable SDK v0.10.1 requires:
 * 1. initThreadPool() for multi-threaded WASM
 * 2. Network-specific imports (@provablehq/sdk/testnet.js or /mainnet.js)
 * 3. getOrInitConsensusVersionTestHeights() for devnode connections
 * 4. ProgramManager with devnode-specific transaction builders
 *
 * This adapter dynamically imports the SDK and checks for required methods.
 * If the SDK is not installed or is too old, it fails with a clear message.
 */

import type { AleoNetwork } from "@lionden/config";

// ---------------------------------------------------------------------------
// Minimal SDK type stubs (avoid hard compile-time dependency)
// ---------------------------------------------------------------------------

export interface SdkObjects {
  account: unknown;
  networkClient: unknown;
  programManager: unknown;
  keyProvider: unknown;
  recordProvider: unknown;
}

// ---------------------------------------------------------------------------
// SDK initialization
// ---------------------------------------------------------------------------

let sdkInitialized = false;

/**
 * Initialize the Provable SDK WASM runtime.
 * Must be called once before any SDK operations.
 */
export async function initSdk(): Promise<void> {
  if (sdkInitialized) return;

  try {
    // Dynamic import — SDK may not be installed
    const sdk = await import("@provablehq/sdk" as string);

    if (typeof sdk.initThreadPool === "function") {
      await sdk.initThreadPool();
    }

    sdkInitialized = true;
  } catch (err: unknown) {
    throw new Error(
      `Failed to initialize @provablehq/sdk. ` +
        `Ensure @provablehq/sdk@^0.10.1 is installed.\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create SDK objects for a given network and endpoint.
 * Validates that required devnode methods exist (version guard).
 */
export async function createSdkObjects(
  network: AleoNetwork,
  endpoint: string,
  privateKey?: string,
): Promise<SdkObjects> {
  await initSdk();

  try {
    // Import network-specific entry point
    const sdkPath =
      network === "mainnet"
        ? "@provablehq/sdk/mainnet.js"
        : "@provablehq/sdk/testnet.js";

    const sdk = await import(sdkPath as string);

    const {
      Account,
      AleoNetworkClient,
      AleoKeyProvider,
      NetworkRecordProvider,
      ProgramManager,
    } = sdk;

    // Create account
    const account = privateKey ? new Account({ privateKey }) : new Account();

    // Create network client
    const networkClient = new AleoNetworkClient(endpoint);

    // Create key and record providers
    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);
    const recordProvider = new NetworkRecordProvider(account, networkClient);

    // Create program manager
    const programManager = new ProgramManager(
      endpoint,
      keyProvider,
      recordProvider,
    );
    programManager.setAccount(account);

    return { account, networkClient, programManager, keyProvider, recordProvider };
  } catch (err: unknown) {
    throw new Error(
      `Failed to create SDK objects for network "${network}" at ${endpoint}. ` +
        `Ensure @provablehq/sdk@^0.10.1 is installed.\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Version guard: check that the SDK has devnode-specific methods.
 * Call this before attempting devnode operations.
 */
export async function checkDevnodeSdkSupport(): Promise<void> {
  await initSdk();

  try {
    const sdk = await import("@provablehq/sdk/testnet.js" as string);
    const { ProgramManager } = sdk;

    const requiredMethods = [
      "buildDevnodeExecutionTransaction",
      "buildDevnodeDeploymentTransaction",
      "buildDevnodeUpgradeTransaction",
    ];

    for (const method of requiredMethods) {
      if (typeof ProgramManager.prototype[method] !== "function") {
        throw new Error(
          `ProgramManager is missing method "${method}". ` +
            `This method requires @provablehq/sdk@^0.10.1. ` +
            `Your installed version may be too old.`,
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("ProgramManager")) {
      throw err;
    }
    throw new Error(
      `Failed to verify SDK devnode support. ` +
        `Ensure @provablehq/sdk@^0.10.1 is installed.\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Initialize consensus version test heights for devnode connections.
 * Required by the SDK before devnode transaction builders can be used.
 */
export async function initConsensusHeights(): Promise<void> {
  try {
    const sdk = await import("@provablehq/sdk/testnet.js" as string);
    if (typeof sdk.getOrInitConsensusVersionTestHeights === "function") {
      sdk.getOrInitConsensusVersionTestHeights("0,1");
    }
  } catch {
    // Non-fatal — may not be needed for all operations
  }
}
