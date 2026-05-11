/**
 * SDK adapter — isolates the @provablehq/sdk initialization ceremony.
 *
 * The Provable SDK v0.10.5 baseline requires:
 * 1. initThreadPool() for multi-threaded WASM
 * 2. Network-specific loading via @provablehq/sdk/dynamic.js
 * 3. getOrInitConsensusVersionTestHeights() for devnode connections
 * 4. ProgramManager with devnode-specific transaction builders
 *
 * This adapter loads the runtime SDK module dynamically per network while
 * keeping TypeScript types anchored to the testnet entrypoint, which matches
 * the mainnet surface in the current SDK release.
 */

import type { AleoNetwork } from "@lionden/config";
import type * as TestnetSdk from "@provablehq/sdk/testnet.js";

// ---------------------------------------------------------------------------
// SDK types
// ---------------------------------------------------------------------------

type SdkModule = typeof TestnetSdk;
type SupportedSdkNetwork = "testnet" | "mainnet";

export interface SdkObjects {
  account: InstanceType<SdkModule["Account"]>;
  networkClient: InstanceType<SdkModule["AleoNetworkClient"]>;
  programManager: InstanceType<SdkModule["ProgramManager"]>;
  keyProvider: InstanceType<SdkModule["AleoKeyProvider"]>;
  recordProvider: InstanceType<SdkModule["NetworkRecordProvider"]>;
}

// ---------------------------------------------------------------------------
// SDK initialization
// ---------------------------------------------------------------------------

const SDK_VERSION = "^0.10.5";

let sdkInitPromise: Promise<void> | undefined;
const sdkModuleCache = new Map<AleoNetwork, Promise<SdkModule>>();

function normalizeSdkNetwork(network: AleoNetwork): SupportedSdkNetwork {
  switch (network) {
    case "mainnet":
      return "mainnet";
    case "testnet":
    case "canary":
      return "testnet";
  }
}

async function loadSdkModule(network: AleoNetwork): Promise<SdkModule> {
  const cached = sdkModuleCache.get(network);
  if (cached) {
    return cached;
  }

  const modulePromise = (async () => {
    const { loadNetwork } = await import("@provablehq/sdk/dynamic.js" as string);
    return (await loadNetwork(normalizeSdkNetwork(network))) as SdkModule;
  })();

  sdkModuleCache.set(network, modulePromise);

  try {
    return await modulePromise;
  } catch (err) {
    sdkModuleCache.delete(network);
    throw err;
  }
}

/**
 * Initialize the Provable SDK WASM runtime.
 * Must be called once before any SDK operations.
 */
export async function initSdk(): Promise<void> {
  if (!sdkInitPromise) {
    sdkInitPromise = (async () => {
      const sdk = await loadSdkModule("testnet");
      if (typeof sdk.initThreadPool === "function") {
        await sdk.initThreadPool();
      }
    })();
  }

  try {
    await sdkInitPromise;
  } catch (err: unknown) {
    sdkInitPromise = undefined;
    throw new Error(
      `Failed to initialize @provablehq/sdk. ` +
        `Ensure @provablehq/sdk@${SDK_VERSION} is installed.\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface CreateSdkObjectsOptions {
  network: AleoNetwork;
  endpoint: string;
  privateKey?: string;
  /** API key passed as Authorization header to AleoNetworkClient. */
  apiKey?: string;
}

/**
 * Create SDK objects for a given network and endpoint.
 * Validates that required devnode methods exist (version guard).
 */
export async function createSdkObjects(
  networkOrOpts: AleoNetwork | CreateSdkObjectsOptions,
  endpoint?: string,
  privateKey?: string,
): Promise<SdkObjects> {
  // Support both positional args and options object
  const opts: CreateSdkObjectsOptions =
    typeof networkOrOpts === "object"
      ? networkOrOpts
      : { network: networkOrOpts, endpoint: endpoint!, privateKey };

  await initSdk();

  try {
    const sdk = await loadSdkModule(opts.network);

    const {
      Account,
      AleoNetworkClient,
      AleoKeyProvider,
      NetworkRecordProvider,
      ProgramManager,
    } = sdk;

    // Create account
    const account = opts.privateKey ? new Account({ privateKey: opts.privateKey }) : new Account();

    // Create network client — pass apiKey as Authorization header if provided
    const networkClientOptions = opts.apiKey
      ? { headers: { Authorization: `Bearer ${opts.apiKey}` } }
      : undefined;
    const networkClient = new AleoNetworkClient(opts.endpoint, networkClientOptions);

    // Create key and record providers
    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);
    const recordProvider = new NetworkRecordProvider(account, networkClient);

    // Create program manager — pass networkClientOptions so the PM's internal
    // network client inherits API key headers for authenticated endpoints.
    const programManager = new ProgramManager(
      opts.endpoint,
      keyProvider,
      recordProvider,
      networkClientOptions,
    );
    programManager.setAccount(account);

    return { account, networkClient, programManager, keyProvider, recordProvider };
  } catch (err: unknown) {
    throw new Error(
      `Failed to create SDK objects for network "${opts.network}" at ${opts.endpoint}. ` +
        `Ensure @provablehq/sdk@${SDK_VERSION} is installed.\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-signer SDK objects
// ---------------------------------------------------------------------------

/**
 * A signer-specific subset of SDK objects. Shares the KeyProvider with the
 * default connection but has its own Account, RecordProvider, and
 * ProgramManager to avoid shared mutable state.
 */
export interface SignerSdkObjects {
  account: InstanceType<SdkModule["Account"]>;
  recordProvider: InstanceType<SdkModule["NetworkRecordProvider"]>;
  programManager: InstanceType<SdkModule["ProgramManager"]>;
}

export interface CreateSignerSdkObjectsOptions {
  privateKey: string;
  endpoint: string;
  network: AleoNetwork;
  keyProvider: SdkObjects["keyProvider"];
  apiKey?: string;
}

/**
 * Create an isolated set of SDK objects for a specific signer.
 * Reuses the shared KeyProvider (proving-key cache) but creates
 * dedicated Account, RecordProvider, and ProgramManager instances.
 */
export async function createSignerSdkObjects(
  opts: CreateSignerSdkObjectsOptions,
): Promise<SignerSdkObjects> {
  await initSdk();

  const sdk = await loadSdkModule(opts.network);
  const {
    Account,
    AleoNetworkClient,
    NetworkRecordProvider,
    ProgramManager,
  } = sdk;

  const account = new Account({ privateKey: opts.privateKey });

  // Dedicated NetworkClient with API key for record lookups
  const ncOptions = opts.apiKey
    ? { headers: { Authorization: `Bearer ${opts.apiKey}` } }
    : undefined;
  const networkClient = new AleoNetworkClient(opts.endpoint, ncOptions);

  const recordProvider = new NetworkRecordProvider(account, networkClient);
  const programManager = new ProgramManager(
    opts.endpoint,
    opts.keyProvider,
    recordProvider,
    ncOptions,
  );
  programManager.setAccount(account);

  return { account, recordProvider, programManager };
}

/**
 * Version guard: check that the SDK has devnode-specific methods.
 * Call this before attempting devnode operations.
 */
export async function checkDevnodeSdkSupport(): Promise<void> {
  await initSdk();

  try {
    const sdk = await loadSdkModule("testnet");
    const { ProgramManager } = sdk;

    const requiredMethods = [
      "buildDevnodeExecutionTransaction",
      "buildDevnodeDeploymentTransaction",
      "buildDevnodeUpgradeTransaction",
    ] as const;
    const programManagerPrototype = ProgramManager.prototype as Record<
      (typeof requiredMethods)[number],
      unknown
    >;

    for (const method of requiredMethods) {
      if (typeof programManagerPrototype[method] !== "function") {
        throw new Error(
          `ProgramManager is missing method "${method}". ` +
            `This method requires @provablehq/sdk@${SDK_VERSION}. ` +
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
        `Ensure @provablehq/sdk@${SDK_VERSION} is installed.\n` +
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
    const sdk = await loadSdkModule("testnet");
    if (typeof sdk.getOrInitConsensusVersionTestHeights === "function") {
      // TOOD: support custom heights
      sdk.getOrInitConsensusVersionTestHeights();
    }
  } catch {
    // Non-fatal — may not be needed for all operations
  }
}
