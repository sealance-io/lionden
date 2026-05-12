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

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  CREDITS_KEY_CACHE_FORMAT,
  fingerprintBytes,
  fingerprintFile,
  fingerprintsEqual,
  readCreditsKeyCacheMetadata,
  writeCreditsKeyCacheMetadata,
} from "@lionden/core";
import type { AleoNetwork, ResolvedSdkKeyCacheConfig } from "@lionden/config";
import type * as TestnetSdk from "@provablehq/sdk/testnet.js";

// ---------------------------------------------------------------------------
// SDK types
// ---------------------------------------------------------------------------

type SdkModule = typeof TestnetSdk;
type SupportedSdkNetwork = "testnet" | "mainnet";
type SdkFunctionKeyProvider = NonNullable<ConstructorParameters<SdkModule["ProgramManager"]>[1]>;
type SdkKeySearchParams = Parameters<SdkFunctionKeyProvider["functionKeys"]>[0];
type SdkFunctionKeyPair = Awaited<ReturnType<SdkFunctionKeyProvider["functionKeys"]>>;
type SdkKeyStore = Awaited<ReturnType<SdkFunctionKeyProvider["keyStore"]>>;
export type SdkProgramManagerBase = SdkModule["ProgramManagerBase"];
type SdkPrivateKey = InstanceType<SdkModule["PrivateKey"]>;

export interface SdkObjects {
  account: InstanceType<SdkModule["Account"]>;
  networkClient: InstanceType<SdkModule["AleoNetworkClient"]>;
  programManager: InstanceType<SdkModule["ProgramManager"]>;
  programManagerBase: SdkProgramManagerBase;
  keyProvider: SdkFunctionKeyProvider;
  recordProvider: InstanceType<SdkModule["NetworkRecordProvider"]>;
}

export interface SdkExecutionKeys {
  provingKey: ReturnType<SdkModule["ProvingKey"]["fromBytes"]>;
  verifyingKey: ReturnType<SdkModule["VerifyingKey"]["fromBytes"]>;
}

export interface SdkRuntimeMetadata {
  readonly sdkVersion?: string;
  readonly wasmVersion?: string;
  readonly wasmHash: string;
}

export interface SynthesizeExecutionKeyBytesOptions {
  readonly programManagerBase: SdkProgramManagerBase;
  readonly privateKey: SdkPrivateKey;
  readonly source: string;
  readonly transitionName: string;
  readonly inputs: readonly string[];
  readonly imports?: Record<string, string>;
  readonly edition?: number;
}

// ---------------------------------------------------------------------------
// SDK initialization
// ---------------------------------------------------------------------------

const SDK_VERSION = "^0.10.5";

let sdkInitPromise: Promise<void> | undefined;
const sdkModuleCache = new Map<AleoNetwork, Promise<SdkModule>>();
const requireFromHere = createRequire(import.meta.url);

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
  keyCache?: ResolvedSdkKeyCacheConfig;
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
      LocalFileKeyStore,
      NetworkRecordProvider,
      ProgramManager,
      ProgramManagerBase,
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

    let effectiveKeyProvider: SdkFunctionKeyProvider = keyProvider;
    if (opts.keyCache?.storage === "filesystem" && opts.keyCache.path) {
      const cachePath = opts.keyCache.path;
      const { wasmHash } = getSdkRuntimeMetadata(opts.network);
      await warmupFeeKeys(keyProvider, sdk, cachePath, opts.network, wasmHash);
      effectiveKeyProvider = new PersistentFunctionKeyProvider(
        keyProvider,
        new LocalFileKeyStore(cachePath),
        { sdk, cachePath, network: opts.network, wasmHash },
      );
    }
    const recordProvider = new NetworkRecordProvider(account, networkClient);

    // Create program manager — pass networkClientOptions so the PM's internal
    // network client inherits API key headers for authenticated endpoints.
    const programManager = new ProgramManager(
      opts.endpoint,
      effectiveKeyProvider,
      recordProvider,
      networkClientOptions,
    );
    programManager.setAccount(account);

    return {
      account,
      networkClient,
      programManager,
      programManagerBase: ProgramManagerBase,
      keyProvider: effectiveKeyProvider,
      recordProvider,
    };
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
  programManagerBase: SdkProgramManagerBase;
}

export interface CreateSignerSdkObjectsOptions {
  privateKey: string;
  endpoint: string;
  network: AleoNetwork;
  keyProvider: SdkObjects["keyProvider"];
  apiKey?: string;
}

export interface FeeKeyPersistenceConfig {
  readonly sdk: SdkModule;
  readonly cachePath: string;
  readonly network: AleoNetwork;
  readonly wasmHash: string;
}

type FeeKeyName = "fee_public" | "fee_private";

export class PersistentFunctionKeyProvider implements SdkFunctionKeyProvider {
  constructor(
    private readonly delegate: SdkFunctionKeyProvider,
    private readonly fileStore: NonNullable<SdkKeyStore>,
    private readonly feePersistence?: FeeKeyPersistenceConfig,
  ) {}

  async keyStore(): Promise<SdkKeyStore> {
    return this.fileStore;
  }

  bondPublicKeys(): Promise<SdkFunctionKeyPair> {
    return this.delegate.bondPublicKeys();
  }

  bondValidatorKeys(): Promise<SdkFunctionKeyPair> {
    return this.delegate.bondValidatorKeys();
  }

  cacheKeys(keyId: string, keys: SdkFunctionKeyPair): void {
    this.delegate.cacheKeys(keyId, keys);
  }

  claimUnbondPublicKeys(): Promise<SdkFunctionKeyPair> {
    return this.delegate.claimUnbondPublicKeys();
  }

  functionKeys(params?: SdkKeySearchParams): Promise<SdkFunctionKeyPair> {
    return this.delegate.functionKeys(params);
  }

  async feePrivateKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.feePrivateKeys();
    this.persistFeeIfMissing("fee_private", keys[0]);
    return keys;
  }

  async feePublicKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.feePublicKeys();
    this.persistFeeIfMissing("fee_public", keys[0]);
    return keys;
  }

  inclusionKeys(): Promise<SdkFunctionKeyPair> {
    return this.delegate.inclusionKeys();
  }

  joinKeys(): Promise<SdkFunctionKeyPair> {
    return this.delegate.joinKeys();
  }

  splitKeys(): Promise<SdkFunctionKeyPair> {
    return this.delegate.splitKeys();
  }

  transferKeys(visibility: string): Promise<SdkFunctionKeyPair> {
    return this.delegate.transferKeys(visibility);
  }

  unBondPublicKeys(): Promise<SdkFunctionKeyPair> {
    return this.delegate.unBondPublicKeys();
  }

  private persistFeeIfMissing(name: FeeKeyName, provingKey: unknown): void {
    const config = this.feePersistence;
    if (!config) return;
    try {
      const credits = (config.sdk as unknown as { CREDITS_PROGRAM_KEYS: Record<string, { locator: string }> }).CREDITS_PROGRAM_KEYS;
      const locator = credits[name]?.locator;
      if (!locator) return;
      const paths = creditsCachePaths(config.cachePath, config.wasmHash, config.network, locator);
      const bytes = keyToBytes(provingKey, "proving");
      const fingerprint = fingerprintBytes(bytes);
      // Skip the write only when the existing on-disk entry is complete and
      // matches what we would write (both files present, metadata identity +
      // fingerprint align). Anything torn or stale gets rewritten so warmup
      // can pick it up on the next run.
      if (isCreditsEntryCurrent(paths, locator, config, fingerprint)) return;
      writeFileAtomic(paths.prover, bytes);
      writeCreditsKeyCacheMetadata(paths.metadata, {
        format: CREDITS_KEY_CACHE_FORMAT,
        locator,
        network: config.network,
        wasmHash: config.wasmHash,
        prover: fingerprint,
      });
    } catch (err) {
      // Persistence is opportunistic — never block the caller.
      console.debug(
        `LionDen: failed to persist credits.aleo/${name} proving key: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** @internal — exported for testing. */
export async function warmupFeeKeys(
  keyProvider: InstanceType<SdkModule["AleoKeyProvider"]>,
  sdk: SdkModule,
  cachePath: string,
  network: AleoNetwork,
  wasmHash: string,
): Promise<void> {
  const credits = (sdk as unknown as {
    CREDITS_PROGRAM_KEYS: Record<string, { locator: string; verifyingKey: () => unknown }>;
  }).CREDITS_PROGRAM_KEYS;
  for (const name of ["fee_public", "fee_private"] as const) {
    const key = credits[name];
    if (!key) continue;
    try {
      const paths = creditsCachePaths(cachePath, wasmHash, network, key.locator);
      if (!fs.existsSync(paths.prover) || !fs.existsSync(paths.metadata)) continue;

      const metadata = readCreditsKeyCacheMetadata(paths.metadata);
      if (!metadata) continue;
      if (metadata.locator !== key.locator) continue;
      if (metadata.network !== network) continue;
      if (metadata.wasmHash !== wasmHash) continue;

      const bytes = new Uint8Array(fs.readFileSync(paths.prover));
      if (!fingerprintsEqual(fingerprintBytes(bytes), metadata.prover)) continue;

      const provingKey = sdk.ProvingKey.fromBytes(bytes);
      const verifyingKey = key.verifyingKey();
      keyProvider.cacheKeys(
        key.locator,
        [provingKey, verifyingKey] as Parameters<SdkFunctionKeyProvider["cacheKeys"]>[1],
      );
    } catch (err) {
      console.debug(
        `LionDen: skipping credits.aleo/${name} warmup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function isCreditsEntryCurrent(
  paths: { prover: string; metadata: string },
  locator: string,
  config: FeeKeyPersistenceConfig,
  fingerprint: ReturnType<typeof fingerprintBytes>,
): boolean {
  if (!fs.existsSync(paths.prover) || !fs.existsSync(paths.metadata)) return false;
  let metadata;
  try {
    metadata = readCreditsKeyCacheMetadata(paths.metadata);
  } catch {
    return false;
  }
  if (!metadata) return false;
  if (metadata.locator !== locator) return false;
  if (metadata.network !== config.network) return false;
  if (metadata.wasmHash !== config.wasmHash) return false;
  if (!fingerprintsEqual(metadata.prover, fingerprint)) return false;
  // Confirm the on-disk prover bytes actually match the metadata claim.
  // Otherwise a corrupted .prover with intact metadata sneaks past write-back
  // and gets rejected by warmup on the next run, leaving a permanently cold
  // entry.
  let onDisk;
  try {
    onDisk = fingerprintFile(paths.prover);
  } catch {
    return false;
  }
  return fingerprintsEqual(onDisk, fingerprint);
}

function creditsCachePaths(
  cachePath: string,
  wasmHash: string,
  network: AleoNetwork,
  locator: string,
): { dir: string; prover: string; metadata: string } {
  // `locator` includes `/` and `:`; base64url avoids any filesystem-hostile chars.
  const safeLocator = Buffer.from(locator, "utf-8").toString("base64url");
  const dir = path.join(cachePath, "lionden-credits", wasmHash, network);
  return {
    dir,
    prover: path.join(dir, `${safeLocator}.prover`),
    metadata: path.join(dir, `${safeLocator}.metadata.json`),
  };
}

function writeFileAtomic(filePath: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  fs.writeFileSync(tmpPath, bytes);
  fs.renameSync(tmpPath, filePath);
}

export async function createExecutionKeysFromBytes(
  network: AleoNetwork,
  keyBytes: { provingKey: Uint8Array; verifyingKey: Uint8Array },
): Promise<SdkExecutionKeys> {
  await initSdk();
  const sdk = await loadSdkModule(network);
  return {
    provingKey: sdk.ProvingKey.fromBytes(new Uint8Array(keyBytes.provingKey)),
    verifyingKey: sdk.VerifyingKey.fromBytes(new Uint8Array(keyBytes.verifyingKey)),
  };
}

export async function synthesizeExecutionKeyBytes(
  options: SynthesizeExecutionKeyBytesOptions,
): Promise<{ provingKeyBytes: Uint8Array; verifyingKeyBytes: Uint8Array }> {
  const keyPair = await options.programManagerBase.synthesizeKeyPair(
    options.privateKey,
    options.source,
    options.transitionName,
    [...options.inputs],
    options.imports,
    options.edition,
  );
  const provingKey = keyPair.provingKey();
  const verifyingKey = keyPair.verifyingKey();

  return {
    provingKeyBytes: keyToBytes(provingKey, "proving"),
    verifyingKeyBytes: keyToBytes(verifyingKey, "verifying"),
  };
}

export function getSdkRuntimeMetadata(network: AleoNetwork): SdkRuntimeMetadata {
  const wasmPath = resolveWasmArtifactPath(network);
  return {
    sdkVersion: readPackageVersion(resolvePackageRoot("@provablehq/sdk/testnet.js")),
    wasmVersion: readPackageVersion(resolvePackageRoot(`@provablehq/wasm/${normalizeSdkNetwork(network)}.js`)),
    wasmHash: crypto.createHash("sha256").update(fs.readFileSync(wasmPath)).digest("hex"),
  };
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
    ProgramManagerBase,
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

  return { account, recordProvider, programManager, programManagerBase: ProgramManagerBase };
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

function keyToBytes(key: unknown, label: "proving" | "verifying"): Uint8Array {
  if (!key || typeof (key as { toBytes?: unknown }).toBytes !== "function") {
    throw new Error(`Synthesized ${label} key does not expose toBytes().`);
  }
  const raw = (key as { toBytes(): unknown }).toBytes();
  if (raw instanceof Uint8Array) {
    return new Uint8Array(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (Array.isArray(raw)) {
    return new Uint8Array(raw);
  }
  throw new Error(`Synthesized ${label} key bytes are not Uint8Array-compatible.`);
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

function resolveWasmArtifactPath(network: AleoNetwork): string {
  const modulePath = requireFromHere.resolve(
    `@provablehq/wasm/${normalizeSdkNetwork(network)}.js`,
  );
  return path.join(path.dirname(modulePath), "aleo_wasm.wasm");
}

function resolvePackageRoot(specifier: string): string | undefined {
  try {
    let current = path.dirname(requireFromHere.resolve(specifier));
    while (true) {
      const packageJson = path.join(current, "package.json");
      if (fs.existsSync(packageJson)) return current;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  } catch {
    return undefined;
  }
}

function readPackageVersion(packageRoot: string | undefined): string | undefined {
  if (!packageRoot) return undefined;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
    ) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
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

// ---------------------------------------------------------------------------
// Value ciphertext decryption (private plaintext outputs / inputs)
// ---------------------------------------------------------------------------

export class NetworkValueDecryptionError extends Error {
  readonly kind = "NetworkValueDecryptionError" as const;
  readonly ciphertextPrefix: string;

  constructor(message: string, ciphertextPrefix: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NetworkValueDecryptionError";
    this.ciphertextPrefix = ciphertextPrefix;
  }
}

/**
 * Decrypt an Aleo value ciphertext (`ciphertext1...`) — the on-wire form for a
 * private plaintext input or output of a transition. Distinct from record
 * ciphertexts, which use a different (record-owner-derived) encryption scheme.
 *
 * Returns the decrypted Leo literal as a string (e.g. `"10000u64"`, `"true"`,
 * `"aleo1..."`), suitable for downstream primitive parsers.
 *
 * `globalIndex` is the position of the input or output in the transition's
 * combined input+output list — Aleo's domain separation places inputs first.
 * For a transition with `N` inputs, output ABI index `i` corresponds to global
 * index `N + i`.
 */
export async function decryptValueCiphertext(
  ciphertext: string,
  viewKey: string,
  tpk: string,
  programId: string,
  transitionName: string,
  globalIndex: number,
  options?: DecryptOptions,
): Promise<string> {
  const prefix = typeof ciphertext === "string" ? ciphertext.slice(0, 16) : "(non-string)";
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new NetworkValueDecryptionError(
      "Value ciphertext must be a non-empty string.",
      prefix,
    );
  }
  if (!ciphertext.startsWith("ciphertext1")) {
    throw new NetworkValueDecryptionError(
      `Value ciphertext must start with "ciphertext1". Received prefix ${JSON.stringify(prefix)}.`,
      prefix,
    );
  }
  if (typeof viewKey !== "string" || !viewKey.startsWith("AViewKey1")) {
    throw new NetworkValueDecryptionError(
      "View key must be a string starting with \"AViewKey1\". To pass a private key, call deriveViewKey() first.",
      prefix,
    );
  }
  if (typeof tpk !== "string" || tpk.length === 0) {
    throw new NetworkValueDecryptionError(
      "Transition public key (tpk) must be a non-empty string.",
      prefix,
    );
  }
  try {
    const sdk = await loadSdkModule(pickSdkNetwork(options));
    // WASM objects are consumed by decryptWithTransitionInfo — caller-side
    // reuse triggers "null pointer passed to rust". Construct fresh per call.
    const vk = sdk.ViewKey.from_string(viewKey);
    const tpkGroup = sdk.Group.fromString(tpk);
    const ct = sdk.Ciphertext.fromString(ciphertext);
    const plaintext = ct.decryptWithTransitionInfo(vk, tpkGroup, programId, transitionName, globalIndex);
    return plaintext.toString();
  } catch (cause: unknown) {
    if (cause instanceof NetworkValueDecryptionError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new NetworkValueDecryptionError(
      `Failed to decrypt value ciphertext (prefix ${JSON.stringify(prefix)}): ${message}`,
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
