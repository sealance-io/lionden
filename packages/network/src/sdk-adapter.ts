/**
 * SDK adapter — isolates the @provablehq/sdk initialization ceremony.
 *
 * The Provable SDK v0.11.0 baseline requires:
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
import { createRequire } from "node:module";
import * as path from "node:path";
import type { AleoNetwork, ResolvedSdkKeyCacheConfig, SdkLogLevel } from "@lionden/config";
import {
  CREDITS_KEY_CACHE_FORMAT,
  fingerprintBytes,
  fingerprintFile,
  fingerprintsEqual,
  readCreditsKeyCacheMetadata,
  writeCreditsKeyCacheMetadata,
} from "@lionden/core";
import type * as TestnetSdk from "@provablehq/sdk/testnet.js";
import type { TransportFunction } from "@provablehq/sdk/testnet.js";
import { Address } from "@provablehq/sdk/testnet.js";

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

/**
 * Cache of derived program addresses. Derivation is a pure function of the
 * program id and allocates+frees a WASM `Address`, so memoize per id.
 */
const programAddressCache = new Map<string, string>();

export function programAddressFromProgramId(programId: string): string {
  const cached = programAddressCache.get(programId);
  if (cached !== undefined) {
    return cached;
  }
  const address = Address.fromProgramId(programId);
  try {
    const derived = address.to_string();
    programAddressCache.set(programId, derived);
    return derived;
  } finally {
    address.free();
  }
}

// ---------------------------------------------------------------------------
// SDK initialization
// ---------------------------------------------------------------------------

const SDK_VERSION = "^0.11.0";

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

export function applySdkLogLevel(sdk: SdkModule, logLevel: SdkLogLevel = "warn"): void {
  const setLogLevel = (sdk as unknown as { setLogLevel?: unknown }).setLogLevel;
  if (typeof setLogLevel === "function") {
    setLogLevel(logLevel);
  }
}

// ---------------------------------------------------------------------------
// Egress policy
// ---------------------------------------------------------------------------

/**
 * Hosts the bundled @provablehq/sdk + WASM can fetch proving parameters and
 * SRS files from. Hardcoded because (a) the SDK's URLs are baked into the
 * WASM, (b) the artifact set is static, and (c) per-network user
 * configuration of this list never delivered a meaningful hermeticity
 * guarantee — true offline / hermetic operation requires a warmed cache
 * plus external network isolation (CI / container / firewall). If a future
 * SDK version adds a new host, update this list.
 */
const KNOWN_SDK_PARAMETER_HOSTS: ReadonlySet<string> = new Set([
  "parameters.provable.com",
  "s3.us-west-1.amazonaws.com",
  "parameters.aleo.org",
]);

/**
 * Runtime SDK egress policy. Governs **network-host** fetches only
 * (chain state, transaction submission). Resolved per-connection in
 * `NetworkManager` and threaded through `createSdkObjects` /
 * `createSignerSdkObjects` so the guarded transport is installed on
 * `AleoNetworkClient`, the `ProgramManager`'s internal client, and every
 * per-signer copy.
 *
 * Beyond filtering egress, installing ANY transport on `AleoNetworkClient`
 * also flips the SDK's `hasCustomTransport` to true, forcing the prove
 * path to use `CallbackQuery` instead of WASM's internal SnapshotQuery —
 * closing the `statePaths` leak where WASM bypasses the JS-configured host.
 *
 * Parameter-host fetches (`AleoKeyProvider`) are guarded against the
 * internal `KNOWN_SDK_PARAMETER_HOSTS` allowlist and are not configurable
 * via this policy.
 */
export interface SdkEgressPolicy {
  /** Hosts the SDK is allowed to call for chain state / submission. */
  readonly allowedNetworkHosts: ReadonlySet<string>;
  /** What to do when a network-host fetch targets a host that's not allowed. */
  readonly violation: "block" | "warn";
}

function urlOf(input: Parameters<TransportFunction>[0]): URL {
  if (typeof Request !== "undefined" && input instanceof Request) {
    return new URL(input.url);
  }
  if (input instanceof URL) return input;
  return new URL(String(input));
}

const GUARDED_TRANSPORT_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const GUARDED_TRANSPORT_MAX_REDIRECTS = 20;

type EgressUrlValidator = (url: URL) => void;

function redirectAwareInit(init: Parameters<TransportFunction>[1]): RequestInit {
  // Force manual redirects so the guard can validate every Location before fetch follows it.
  return { ...init, redirect: "manual" };
}

function nextRedirectInit(
  init: Parameters<TransportFunction>[1],
  status: number,
): Parameters<TransportFunction>[1] {
  const method = init?.method?.toUpperCase();
  const shouldSwitchToGet =
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  if (shouldSwitchToGet) {
    const next: RequestInit = { ...init, method: "GET" };
    delete next.body;
    if (next.headers) {
      const headers = new Headers(next.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("content-type");
      next.headers = headers;
    }
    return next;
  }
  return init;
}

async function fetchWithEgressGuardedRedirects(
  input: Parameters<TransportFunction>[0],
  init: Parameters<TransportFunction>[1],
  validateUrl: EgressUrlValidator,
): Promise<Response> {
  let currentUrl: URL;
  try {
    currentUrl = urlOf(input);
  } catch {
    return fetch(input as Parameters<typeof fetch>[0], redirectAwareInit(init));
  }

  let currentInput = input as Parameters<typeof fetch>[0];
  let currentInit = init;
  let redirectCount = 0;
  const visited = new Set<string>();

  for (;;) {
    validateUrl(currentUrl);
    if (visited.has(currentUrl.href)) {
      throw new Error(`LionDen SDK transport detected redirect loop to "${currentUrl.href}".`);
    }
    visited.add(currentUrl.href);

    const response = await fetch(currentInput, redirectAwareInit(currentInit));
    if (!GUARDED_TRANSPORT_REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    if (redirectCount >= GUARDED_TRANSPORT_MAX_REDIRECTS) {
      throw new Error(
        `LionDen SDK transport exceeded ${GUARDED_TRANSPORT_MAX_REDIRECTS} redirects.`,
      );
    }

    const nextUrl = new URL(location, currentUrl);
    redirectCount += 1;
    currentUrl = nextUrl;
    currentInput = nextUrl;
    currentInit = nextRedirectInit(currentInit, response.status);
  }
}

/**
 * Build a `fetch`-shaped transport for SDK **network-host** calls
 * (chain state, transaction submission). On a host outside `allowed`,
 * rejects when `violation === "block"` and logs-then-forwards when
 * `violation === "warn"`. Warn mode forwards the SDK request unchanged,
 * including headers, so use it only when intentionally observing egress
 * instead of enforcing it. Exported for unit testing.
 */
export function makeNetworkTransport(
  allowed: ReadonlySet<string>,
  violation: "block" | "warn",
): TransportFunction {
  return (input, init) => {
    return fetchWithEgressGuardedRedirects(input, init, (url) => {
      if (!allowed.has(url.host)) {
        const msg =
          `LionDen blocked SDK network fetch to host "${url.host}". ` +
          `Allowed hosts: ${
            allowed.size === 0 ? "(none)" : Array.from(allowed).join(", ")
          }. Extend sdk.egress.networkHosts or change sdk.egress.violation.`;
        if (violation === "block") {
          throw new Error(msg);
        }
        console.warn(msg);
      }
    });
  };
}

/**
 * Build a `fetch`-shaped transport for SDK **parameter-host** calls
 * (credits proving/verifying keys, SRS files). Allowlist is the
 * module-private `KNOWN_SDK_PARAMETER_HOSTS`; violation is always block.
 * An unknown host means LionDen's allowlist is stale relative to the
 * installed SDK, surfaced as a clear actionable error. Exported for
 * unit testing.
 */
export function makeParameterTransport(): TransportFunction {
  return (input, init) => {
    return fetchWithEgressGuardedRedirects(input, init, (url) => {
      if (!KNOWN_SDK_PARAMETER_HOSTS.has(url.host)) {
        const msg =
          `LionDen does not recognize SDK parameter host "${url.host}". ` +
          `Known hosts: ${Array.from(KNOWN_SDK_PARAMETER_HOSTS).join(", ")}. ` +
          `This may indicate a stale LionDen allowlist; please report.`;
        throw new Error(msg);
      }
    });
  };
}

export interface CreateSdkObjectsOptions {
  network: AleoNetwork;
  endpoint: string;
  privateKey?: string;
  /** API key passed as Authorization header to AleoNetworkClient. */
  apiKey?: string;
  keyCache?: ResolvedSdkKeyCacheConfig;
  logLevel?: SdkLogLevel;
  /**
   * Egress policy for SDK network-host fetches. Required — installing the
   * guarded transport is what flips `hasCustomTransport=true` and forces
   * the prove path to use `CallbackQuery` instead of WASM's internal
   * SnapshotQuery (which is baked to `https://api.provable.com/v2`). Every
   * production caller threads a per-connection policy through
   * `NetworkManager`. Parameter-host fetches are guarded against an
   * internal known-host list (`KNOWN_SDK_PARAMETER_HOSTS`) and are not
   * configurable via this policy.
   */
  egressPolicy: SdkEgressPolicy;
}

/**
 * Create SDK objects for a given network and endpoint.
 * Validates that required devnode methods exist (version guard).
 */
export async function createSdkObjects(opts: CreateSdkObjectsOptions): Promise<SdkObjects> {
  assertValidEndpoint(opts.endpoint, "createSdkObjects");

  await initSdk();

  try {
    const sdk = await loadSdkModule(opts.network);
    applySdkLogLevel(sdk, opts.logLevel);

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

    // Network transport (chain state, transaction submission). Installing
    // the transport on AleoNetworkClient flips hasCustomTransport=true in
    // the SDK, forcing the prove path to use CallbackQuery instead of
    // WASM's internal SnapshotQuery (closes the statePaths leak).
    // networkClientOptions is also passed to ProgramManager below so its
    // internal AleoNetworkClient inherits the same transport.
    const networkTransport = makeNetworkTransport(
      opts.egressPolicy.allowedNetworkHosts,
      opts.egressPolicy.violation,
    );

    const networkClientOptions: { headers?: Record<string, string>; transport: TransportFunction } =
      {
        transport: networkTransport,
      };
    if (opts.apiKey) {
      networkClientOptions.headers = { Authorization: `Bearer ${opts.apiKey}` };
    }
    const networkClient = new AleoNetworkClient(opts.endpoint, networkClientOptions);

    // Parameter transport (credits proving/verifying keys, SRS files).
    // Always installed — allowlist is an internal LionDen invariant
    // (KNOWN_SDK_PARAMETER_HOSTS) independent of egressPolicy.
    const keyProvider = new AleoKeyProvider({ transport: makeParameterTransport() });
    keyProvider.useCache(true);

    let effectiveKeyProvider: SdkFunctionKeyProvider = keyProvider;
    if (opts.keyCache?.storage === "filesystem" && opts.keyCache.path) {
      const cachePath = opts.keyCache.path;
      const { wasmHash } = getSdkRuntimeMetadata(opts.network);
      await warmupCreditsKeys(keyProvider, sdk, cachePath, opts.network, wasmHash);
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
  logLevel?: SdkLogLevel;
  /** Required — same rationale as on `CreateSdkObjectsOptions`. */
  egressPolicy: SdkEgressPolicy;
}

export interface CreditsKeyPersistenceConfig {
  readonly sdk: SdkModule;
  readonly cachePath: string;
  readonly network: AleoNetwork;
  readonly wasmHash: string;
}

/**
 * Names of credits.aleo keys we can persist by-name. These are the
 * function-key-provider methods that map 1:1 to a single entry in the
 * SDK's CREDITS_PROGRAM_KEYS map. `transferKeys(visibility)` is handled
 * separately because its credits-key target depends on the visibility
 * argument.
 */
type CreditsKeyName =
  | "bond_public"
  | "bond_validator"
  | "claim_unbond_public"
  | "fee_private"
  | "fee_public"
  | "inclusion"
  | "join"
  | "split"
  | "unbond_public";

/**
 * Resolve which credits.aleo entry (if any) a `functionKeys()` call
 * refers to. The SDK reaches some entries — notably `set_validator_state`
 * — only through the generic `functionKeys()` path with one of:
 *   - `{ name: "<credits_entry>" }`
 *   - `{ cacheKey: "credits.aleo/<credits_entry>" }`
 *   - `{ proverUri, verifierUri, cacheKey? }` where the URIs match an
 *     entry's prover/verifier in `CREDITS_PROGRAM_KEYS`.
 * Returns the matching entry name, or `undefined` if the params do not
 * identify a known credits entry. Non-credits user keys are intentionally
 * left unpersisted (LionDen does not own arbitrary-locator persistence).
 */
function creditsEntryFromFunctionKeysParams(
  sdk: SdkModule,
  params: SdkKeySearchParams | undefined,
): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const credits = (
    sdk as unknown as {
      CREDITS_PROGRAM_KEYS: Record<string, { locator: string; prover: string; verifier: string }>;
    }
  ).CREDITS_PROGRAM_KEYS;
  const p = params as Record<string, unknown>;

  const name = typeof p.name === "string" ? p.name : undefined;
  if (name && Object.hasOwn(credits, name) && name !== "getKey") {
    return name;
  }

  const cacheKey = typeof p.cacheKey === "string" ? p.cacheKey : undefined;
  if (cacheKey) {
    const prefix = "credits.aleo/";
    if (cacheKey.startsWith(prefix)) {
      const entry = cacheKey.slice(prefix.length);
      if (Object.hasOwn(credits, entry) && entry !== "getKey") {
        return entry;
      }
    }
  }

  const proverUri = typeof p.proverUri === "string" ? p.proverUri : undefined;
  if (proverUri) {
    for (const [entry, value] of Object.entries(credits)) {
      if (entry === "getKey") continue;
      if (value && typeof value === "object" && value.prover === proverUri) {
        return entry;
      }
    }
  }

  return undefined;
}

/**
 * Map a `transferKeys(visibility)` argument to the corresponding entry
 * in CREDITS_PROGRAM_KEYS. Mirrors the SDK's visibility sets at
 * `node_modules/@provablehq/sdk/dist/testnet/browser.js:2913-2929`.
 * Unknown visibility strings fall through (returns `undefined`) so the
 * delegate result is still returned to the caller; only persistence is
 * skipped.
 */
function transferKeyNameForVisibility(visibility: string): string | undefined {
  switch (visibility) {
    case "private":
    case "transfer_private":
    case "transferPrivate":
      return "transfer_private";
    case "private_to_public":
    case "privateToPublic":
    case "transfer_private_to_public":
    case "transferPrivateToPublic":
      return "transfer_private_to_public";
    case "public":
    case "transfer_public":
    case "transferPublic":
      return "transfer_public";
    case "public_as_signer":
    case "transfer_public_as_signer":
    case "transferPublicAsSigner":
      return "transfer_public_as_signer";
    case "public_to_private":
    case "publicToPrivate":
    case "transfer_public_to_private":
    case "transferPublicToPrivate":
      return "transfer_public_to_private";
    default:
      return undefined;
  }
}

export class PersistentFunctionKeyProvider implements SdkFunctionKeyProvider {
  constructor(
    private readonly delegate: SdkFunctionKeyProvider,
    private readonly fileStore: NonNullable<SdkKeyStore>,
    private readonly creditsPersistence?: CreditsKeyPersistenceConfig,
  ) {}

  async keyStore(): Promise<SdkKeyStore> {
    return this.fileStore;
  }

  async bondPublicKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.bondPublicKeys();
    this.persistCreditsIfMissing("bond_public", keys[0]);
    return keys;
  }

  async bondValidatorKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.bondValidatorKeys();
    this.persistCreditsIfMissing("bond_validator", keys[0]);
    return keys;
  }

  cacheKeys(keyId: string, keys: SdkFunctionKeyPair): void {
    this.delegate.cacheKeys(keyId, keys);
  }

  async claimUnbondPublicKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.claimUnbondPublicKeys();
    this.persistCreditsIfMissing("claim_unbond_public", keys[0]);
    return keys;
  }

  async functionKeys(params?: SdkKeySearchParams): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.functionKeys(params);
    // The SDK reaches some credits.aleo entries (notably `set_validator_state`)
    // only through this generic path. Persist them by name when the params
    // identify a known entry; non-credits user keys are left to the
    // delegate's own in-memory cache.
    const config = this.creditsPersistence;
    if (config) {
      const entry = creditsEntryFromFunctionKeysParams(config.sdk, params);
      if (entry) this.persistCreditsIfMissing(entry, keys[0]);
    }
    return keys;
  }

  async feePrivateKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.feePrivateKeys();
    this.persistCreditsIfMissing("fee_private", keys[0]);
    return keys;
  }

  async feePublicKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.feePublicKeys();
    this.persistCreditsIfMissing("fee_public", keys[0]);
    return keys;
  }

  async inclusionKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.inclusionKeys();
    this.persistCreditsIfMissing("inclusion", keys[0]);
    return keys;
  }

  async joinKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.joinKeys();
    this.persistCreditsIfMissing("join", keys[0]);
    return keys;
  }

  async splitKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.splitKeys();
    this.persistCreditsIfMissing("split", keys[0]);
    return keys;
  }

  async transferKeys(visibility: string): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.transferKeys(visibility);
    const name = transferKeyNameForVisibility(visibility);
    if (name !== undefined) {
      this.persistCreditsIfMissing(name, keys[0]);
    }
    return keys;
  }

  async unBondPublicKeys(): Promise<SdkFunctionKeyPair> {
    const keys = await this.delegate.unBondPublicKeys();
    this.persistCreditsIfMissing("unbond_public", keys[0]);
    return keys;
  }

  /**
   * Persist a credits.aleo proving key to disk so the next process can
   * warm its in-memory cache without re-fetching from the public
   * parameters host. Performance-only — hermeticity comes from the
   * SDK egress policy, not from caching.
   */
  private persistCreditsIfMissing(name: CreditsKeyName | string, provingKey: unknown): void {
    const config = this.creditsPersistence;
    if (!config) return;
    try {
      const credits = (
        config.sdk as unknown as { CREDITS_PROGRAM_KEYS: Record<string, { locator: string }> }
      ).CREDITS_PROGRAM_KEYS;
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

/**
 * Warm the SDK's in-memory key cache from disk for every credits.aleo
 * key that has a complete on-disk entry. Frame as performance only —
 * hermeticity is enforced by the SDK egress policy, not the cache.
 *
 * Iterates every named entry of `CREDITS_PROGRAM_KEYS` (skipping the
 * helper functions like `getKey`). Entries without a complete and
 * fingerprint-matching cache entry are skipped silently.
 *
 * @internal — exported for testing.
 */
export async function warmupCreditsKeys(
  keyProvider: InstanceType<SdkModule["AleoKeyProvider"]>,
  sdk: SdkModule,
  cachePath: string,
  network: AleoNetwork,
  wasmHash: string,
): Promise<void> {
  const credits = (
    sdk as unknown as {
      CREDITS_PROGRAM_KEYS: Record<string, unknown>;
    }
  ).CREDITS_PROGRAM_KEYS;

  for (const [name, value] of Object.entries(credits)) {
    if (!isWarmableCreditsEntry(value)) continue;
    const key = value;
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
      keyProvider.cacheKeys(key.locator, [provingKey, verifyingKey] as Parameters<
        SdkFunctionKeyProvider["cacheKeys"]
      >[1]);
    } catch (err) {
      console.debug(
        `LionDen: skipping credits.aleo/${name} warmup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function isWarmableCreditsEntry(
  value: unknown,
): value is { locator: string; verifyingKey: () => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { locator?: unknown }).locator === "string" &&
    typeof (value as { verifyingKey?: unknown }).verifyingKey === "function"
  );
}

function isCreditsEntryCurrent(
  paths: { prover: string; metadata: string },
  locator: string,
  config: CreditsKeyPersistenceConfig,
  fingerprint: ReturnType<typeof fingerprintBytes>,
): boolean {
  if (!fs.existsSync(paths.prover) || !fs.existsSync(paths.metadata)) return false;
  let metadata: ReturnType<typeof readCreditsKeyCacheMetadata>;
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
  let onDisk: ReturnType<typeof fingerprintFile>;
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
  // Retained for future query-bound synthesis or explicit diagnostics. Runtime
  // execution no longer calls this on cache misses because the SDK eager
  // synthesis path cannot receive LionDen's guarded query object.
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
    wasmVersion: readPackageVersion(
      resolvePackageRoot(`@provablehq/wasm/${normalizeSdkNetwork(network)}.js`),
    ),
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
  assertValidEndpoint(opts.endpoint, "createSignerSdkObjects");
  await initSdk();

  const sdk = await loadSdkModule(opts.network);
  applySdkLogLevel(sdk, opts.logLevel);
  const { Account, AleoNetworkClient, NetworkRecordProvider, ProgramManager, ProgramManagerBase } =
    sdk;

  const account = new Account({ privateKey: opts.privateKey });

  // Dedicated NetworkClient with API key for record lookups. Install the
  // same guarded network transport that createSdkObjects uses so the
  // per-signer PM's internal AleoNetworkClient also reports
  // hasCustomTransport=true and routes prove-time state queries through
  // JS. The signer path reuses the default connection's keyProvider, so
  // no parameter transport is installed here.
  const networkTransport = makeNetworkTransport(
    opts.egressPolicy.allowedNetworkHosts,
    opts.egressPolicy.violation,
  );
  const ncOptions: { headers?: Record<string, string>; transport: TransportFunction } = {
    transport: networkTransport,
  };
  if (opts.apiKey) ncOptions.headers = { Authorization: `Bearer ${opts.apiKey}` };
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

function assertValidEndpoint(endpoint: unknown, context: string): asserts endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error(`${context} requires a non-empty endpoint string.`);
  }
  try {
    new URL(endpoint);
  } catch {
    throw new Error(`${context}: invalid endpoint URL "${endpoint}".`);
  }
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
  const modulePath = requireFromHere.resolve(`@provablehq/wasm/${normalizeSdkNetwork(network)}.js`);
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
    const raw = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
      version?: unknown;
    };
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
    throw new NetworkRecordDecryptionError("Record ciphertext must be a non-empty string.", prefix);
  }
  if (!ciphertext.startsWith("record1")) {
    throw new NetworkRecordDecryptionError(
      `Record ciphertext must start with "record1". Received prefix ${JSON.stringify(prefix)}.`,
      prefix,
    );
  }
  if (typeof viewKey !== "string" || !viewKey.startsWith("AViewKey1")) {
    throw new NetworkRecordDecryptionError(
      'View key must be a string starting with "AViewKey1". To pass a private key, call deriveViewKey() first.',
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
    throw new NetworkValueDecryptionError("Value ciphertext must be a non-empty string.", prefix);
  }
  if (!ciphertext.startsWith("ciphertext1")) {
    throw new NetworkValueDecryptionError(
      `Value ciphertext must start with "ciphertext1". Received prefix ${JSON.stringify(prefix)}.`,
      prefix,
    );
  }
  if (typeof viewKey !== "string" || !viewKey.startsWith("AViewKey1")) {
    throw new NetworkValueDecryptionError(
      'View key must be a string starting with "AViewKey1". To pass a private key, call deriveViewKey() first.',
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
    const plaintext = ct.decryptWithTransitionInfo(
      vk,
      tpkGroup,
      programId,
      transitionName,
      globalIndex,
    );
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
export async function deriveViewKey(privateKey: string, options?: DecryptOptions): Promise<string> {
  if (typeof privateKey !== "string" || !privateKey.startsWith("APrivateKey1")) {
    throw new NetworkRecordDecryptionError(
      'Private key must be a string starting with "APrivateKey1".',
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
