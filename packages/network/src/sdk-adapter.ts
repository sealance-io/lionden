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

// ---------------------------------------------------------------------------
// Record ciphertext decryption
// ---------------------------------------------------------------------------

export interface DecryptOptions {
  /**
   * Which SDK network module to load for the crypto primitives.
   * Defaults to whichever module is already cached (any), else "testnet".
   * RecordCiphertext/ViewKey/PrivateKey are crypto-agnostic across networks
   * so this only governs module-load policy.
   */
  readonly network?: SupportedSdkNetwork;
}

export class NetworkRecordDecryptionError extends Error {
  readonly kind = "NetworkRecordDecryptionError" as const;
  readonly ciphertextPrefix: string;

  constructor(message: string, ciphertextPrefix: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NetworkRecordDecryptionError";
    this.ciphertextPrefix = ciphertextPrefix;
  }
}

function pickSdkNetwork(options?: DecryptOptions): SupportedSdkNetwork {
  if (options?.network) return options.network;
  // Reuse any already-loaded SDK module to avoid double-loading.
  for (const network of sdkModuleCache.keys()) {
    return normalizeSdkNetwork(network);
  }
  return "testnet";
}

/**
 * Decrypt an Aleo record ciphertext using a view key.
 * Returns the plaintext record literal (a string suitable for downstream
 * `deserialize<Name>` parsing). View key must already be a string view key
 * (`AViewKey1...`). To accept a private key, call `deriveViewKey` first.
 */
export async function decryptRecordCiphertext(
  ciphertext: string,
  viewKey: string,
  options?: DecryptOptions,
): Promise<string> {
  const prefix = typeof ciphertext === "string" ? ciphertext.slice(0, 16) : "(non-string)";
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new NetworkRecordDecryptionError(
      "Record ciphertext must be a non-empty string.",
      prefix,
    );
  }
  if (!ciphertext.startsWith("record1")) {
    throw new NetworkRecordDecryptionError(
      `Record ciphertext must start with "record1". Received prefix ${JSON.stringify(prefix)}.`,
      prefix,
    );
  }
  if (typeof viewKey !== "string" || !viewKey.startsWith("AViewKey1")) {
    throw new NetworkRecordDecryptionError(
      "View key must be a string starting with \"AViewKey1\". To pass a private key, call deriveViewKey() first.",
      prefix,
    );
  }
  try {
    const sdk = await loadSdkModule(pickSdkNetwork(options));
    const vk = sdk.ViewKey.from_string(viewKey);
    const ct = sdk.RecordCiphertext.fromString(ciphertext);
    const plaintext = ct.decrypt(vk);
    // SDK returns RecordPlaintext; toString() yields the Leo literal.
    return plaintext.toString();
  } catch (cause: unknown) {
    if (cause instanceof NetworkRecordDecryptionError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new NetworkRecordDecryptionError(
      `Failed to decrypt record ciphertext (prefix ${JSON.stringify(prefix)}): ${message}`,
      prefix,
      cause,
    );
  }
}

/**
 * Derive a view key string (`AViewKey1...`) from a private key string
 * (`APrivateKey1...`). Used by callers that pass private keys to decrypt.
 */
export async function deriveViewKey(
  privateKey: string,
  options?: DecryptOptions,
): Promise<string> {
  if (typeof privateKey !== "string" || !privateKey.startsWith("APrivateKey1")) {
    throw new NetworkRecordDecryptionError(
      "Private key must be a string starting with \"APrivateKey1\".",
      typeof privateKey === "string" ? privateKey.slice(0, 16) : "(non-string)",
    );
  }
  try {
    const sdk = await loadSdkModule(pickSdkNetwork(options));
    const pk = sdk.PrivateKey.from_string(privateKey);
    return pk.to_view_key().to_string();
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new NetworkRecordDecryptionError(
      `Failed to derive view key: ${message}`,
      privateKey.slice(0, 16),
      cause,
    );
  }
}
