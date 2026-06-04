/**
 * AleoConnection — concrete implementation of NetworkConnection.
 *
 * Delegates to the Provable SDK's AleoNetworkClient for queries and
 * transaction broadcasting, and to ProgramManager for transaction building.
 */

import * as fs from "node:fs";
import type {
  AleoNetwork,
  ResolvedSdkKeyCacheConfig,
  RuntimeImportRef,
  SdkLogLevel,
} from "@lionden/config";
import { normalizeRuntimeImportRef } from "@lionden/config";
import {
  buildRuntimeKeyIdentity,
  findCachedExecutionKeys,
  type ProgramExecutionArtifacts,
  resolveProgramExecutionArtifacts,
} from "./execution-key-cache.js";
import type { SdkEgressPolicy, SdkObjects, SignerSdkObjects } from "./sdk-adapter.js";
import { selectMatchingTransition } from "./transition-selector.js";
import {
  type ConfirmedTransaction,
  type ConfirmedTransitionRecord,
  type ExecuteOptions,
  LocalVmExecutionError,
  NetworkConfirmationTimeoutError,
  type NetworkConnection,
  type RawTransitionOutput,
  type TransitionCallResult,
  TransitionRejectedError,
} from "./types.js";

export interface ConnectionOptions {
  type: "devnode" | "http";
  name: string;
  endpoint: string;
  networkId: AleoNetwork;
  privateKey?: string;
  /** API key for explorer/node authentication. */
  apiKey?: string;
  /** Absolute artifacts directory for local source/key metadata lookup. */
  artifactsDir?: string;
  /** Resolved Provable SDK key-cache config. */
  keyCache?: ResolvedSdkKeyCacheConfig;
  /** Resolved Provable SDK log level. */
  logLevel?: SdkLogLevel;
  /** SDK egress policy for this connection. Required; default resolved per connection by NetworkManager (network-host scope only — parameter downloads use an internal SDK host list). */
  egressPolicy: SdkEgressPolicy;
  /**
   * Absolute project root, used to anchor relative path refs that arrive
   * via per-call `ExecuteOptions.imports`. Config-level execution imports
   * are already absolutized before they reach the connection.
   */
  projectRoot: string;
  /**
   * Resolved config-level runtime-import refs, keyed by dispatching
   * program id. Concatenated with per-call refs at execute time.
   */
  executionImports?: Readonly<Record<string, readonly RuntimeImportRef[]>>;
}

/**
 * Thrown when a 2xx response body fails to match the expected confirmed-tx
 * shape (missing required fields, wrong types). Distinct from transient
 * network errors — the polling loop must NOT retry on this class.
 */
export class TransactionShapeParseError extends Error {
  readonly kind = "TransactionShapeParseError" as const;
  readonly txId: string;
  readonly field: string;

  constructor(message: string, txId: string, field: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TransactionShapeParseError";
    this.txId = txId;
    this.field = field;
  }
}

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;
const CONFIRMATION_POLL_INTERVAL_MS = 1_000;

export class AleoConnection implements NetworkConnection {
  readonly type: "devnode" | "http";
  readonly name: string;
  readonly endpoint: string;
  readonly networkId: AleoNetwork;
  readonly privateKey?: string;
  readonly apiKey?: string;
  readonly egressPolicy: SdkEgressPolicy;
  private readonly artifactsDir?: string;
  private readonly keyCache?: ResolvedSdkKeyCacheConfig;
  private readonly logLevel?: SdkLogLevel;
  private readonly projectRoot: string;
  private readonly executionImports: Readonly<Record<string, readonly RuntimeImportRef[]>>;

  private sdkObjects?: SdkObjects;
  private sdkObjectsPromise?: Promise<SdkObjects>;
  private _closed = false;

  /** Whether this connection has been permanently closed. */
  get closed(): boolean {
    return this._closed;
  }

  /** Throws if this connection has been closed. */
  private assertOpen(): void {
    if (this._closed) {
      throw new Error("Connection is closed.");
    }
  }

  // Per-signer SDK object cache — isolated PM + RecordProvider + Account per key
  private signerSdkResolved = new Map<string, SignerSdkObjects>();
  private signerSdkInflight = new Map<string, Promise<SignerSdkObjects>>();

  constructor(options: ConnectionOptions) {
    this.type = options.type;
    this.name = options.name;
    this.endpoint = options.endpoint;
    this.networkId = options.networkId;
    this.privateKey = options.privateKey;
    this.apiKey = options.apiKey;
    this.egressPolicy = options.egressPolicy;
    this.artifactsDir = options.artifactsDir;
    this.keyCache = options.keyCache;
    this.logLevel = options.logLevel;
    this.projectRoot = options.projectRoot;
    this.executionImports = options.executionImports ?? {};

    // Devnode connections support block advancement
    if (this.type === "devnode") {
      this.advanceBlocks = async (count: number) => {
        this.assertOpen();
        for (let i = 0; i < count; i++) {
          const url = `${this.endpoint}/${this.networkId}/block/create`;
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ num_blocks: 1 }),
          });
          if (!response.ok) {
            throw new Error(`Failed to advance block: ${response.status} ${response.statusText}`);
          }
        }
      };
    }
  }

  /** Lazy-init and cache SDK objects for this connection. */
  private async getSdkObjects(): Promise<SdkObjects> {
    this.assertOpen();
    if (this.sdkObjects) return this.sdkObjects;

    if (!this.sdkObjectsPromise) {
      this.sdkObjectsPromise = (async () => {
        const { createSdkObjects } = await import("./sdk-adapter.js");
        const objects = await createSdkObjects({
          network: this.networkId,
          endpoint: this.endpoint,
          privateKey: this.privateKey,
          apiKey: this.apiKey,
          keyCache: this.keyCache,
          logLevel: this.logLevel,
          egressPolicy: this.egressPolicy,
        });
        // Guard: if close() was called while we were initializing,
        // destroy the account and bail out.
        if (this._closed) {
          tryDestroyAccount(objects.account);
          throw new Error("Connection closed during SDK initialization.");
        }
        this.sdkObjects = objects;
        return objects;
      })();
    }

    return this.sdkObjectsPromise;
  }

  /**
   * Get the effective ProgramManager for an execution.
   * Returns the default PM when no signer override is given,
   * or a per-signer isolated PM otherwise.
   */
  private async getEffectivePm(signerPrivateKey?: string): Promise<{ pm: unknown; nc: unknown }> {
    const defaultSdk = await this.getSdkObjects();

    if (!signerPrivateKey || signerPrivateKey === this.privateKey) {
      return {
        pm: defaultSdk.programManager,
        nc: defaultSdk.networkClient,
      };
    }

    // Check resolved cache
    const resolved = this.signerSdkResolved.get(signerPrivateKey);
    if (resolved) {
      return {
        pm: resolved.programManager,
        nc: defaultSdk.networkClient,
      };
    }

    // Check inflight cache
    let inflight = this.signerSdkInflight.get(signerPrivateKey);
    if (!inflight) {
      inflight = (async () => {
        const { createSignerSdkObjects } = await import("./sdk-adapter.js");
        const signerSdk = await createSignerSdkObjects({
          privateKey: signerPrivateKey,
          endpoint: this.endpoint,
          network: this.networkId,
          keyProvider: defaultSdk.keyProvider,
          apiKey: this.apiKey,
          logLevel: this.logLevel,
          egressPolicy: this.egressPolicy,
        });

        // If close() was called while creating, destroy and bail
        if (this._closed) {
          tryDestroyAccount(signerSdk.account);
          throw new Error("Connection closed during signer SDK initialization.");
        }

        this.signerSdkResolved.set(signerPrivateKey, signerSdk);
        this.signerSdkInflight.delete(signerPrivateKey);
        return signerSdk;
      })();

      this.signerSdkInflight.set(signerPrivateKey, inflight);

      // Evict from inflight on rejection so retries work
      inflight.catch(() => {
        this.signerSdkInflight.delete(signerPrivateKey);
      });
    }

    const signerSdk = await inflight;
    return {
      pm: signerSdk.programManager,
      nc: defaultSdk.networkClient,
    };
  }

  async getBalance(address?: string): Promise<bigint> {
    this.assertOpen();
    const addr = address ?? (await this.getDefaultAddress());
    const value = await this.getMappingValue("credits.aleo", "account", addr);
    if (value === null) return 0n;
    // Value looks like "123456u64" — strip the suffix
    return BigInt(value.replace(/u\d+$/i, ""));
  }

  async getMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string | null> {
    this.assertOpen();
    const sdk = await this.getSdkObjects();
    const nc = sdk.networkClient as any;

    try {
      const value: string | undefined = await nc.getProgramMappingValue(
        programId,
        mappingName,
        key,
      );
      if (value === undefined || value === null) return null;
      return typeof value === "string" ? value : String(value);
    } catch (err: unknown) {
      // SDK throws on 404 / missing key — treat as null
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("404") ||
        message.includes("not found") ||
        message.includes("Not Found")
      ) {
        return null;
      }
      throw new Error(`Failed to query mapping ${programId}/${mappingName}: ${message}`);
    }
  }

  async execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<TransitionCallResult> {
    this.assertOpen();
    if (this.type === "devnode") {
      const { checkDevnodeSdkSupport, initConsensusHeights } = await import("./sdk-adapter.js");
      // Enforce the SDK baseline for devnode operations.
      await checkDevnodeSdkSupport();
      await initConsensusHeights();
    }

    // Resolve the effective ProgramManager — uses a per-signer isolated PM
    // when options.signer is provided, otherwise the connection's default.
    const { pm: effectivePm, nc: effectiveNc } = await this.getEffectivePm(
      options?.signer?.privateKey,
    );
    const pm = effectivePm as any;
    const nc = effectiveNc as any;
    const mode = options?.mode ?? "onchain";

    // Resolve runtime imports (config layer + per-call layer) once.
    // Path refs are absolutized via @lionden/config helpers; missing files
    // fail-fast here with a clear error before we touch the SDK.
    const runtimeImports = this.collectRuntimeImports(programId, options?.imports);

    // Resolve program source + transitive imports once for every mode.
    // includeSidecar=true is safe everywhere; it's a cheap fs read and only
    // consulted when the filesystem keycache path is exercised below.
    const artifacts = await resolveProgramExecutionArtifacts({
      artifactsDir: this.artifactsDir,
      programId,
      networkClient: nc,
      includeSidecar: true,
      runtimeImports,
    });

    if (mode === "local") {
      // Local execution — run without generating proofs.
      const result = await pm.run(
        artifacts.source,
        transitionName,
        args,
        false, // proveExecution = false
        artifacts.imports,
      );
      const outputs = extractLocalExecutionOutputs(result);
      return {
        outputs,
      };
    }

    // On-chain execution
    let txId: string;

    const useDevnodeFastPath =
      this.type === "devnode" &&
      !options?.prove &&
      typeof pm.buildDevnodeExecutionTransaction === "function";

    const importsSlice = artifacts.imports === undefined ? {} : { imports: artifacts.imports };

    if (useDevnodeFastPath) {
      // Devnode fast-path — skips proof generation
      const tx = await pm.buildDevnodeExecutionTransaction({
        programName: programId,
        functionName: transitionName,
        inputs: args,
        priorityFee: options?.fee ?? 0,
        privateFee: options?.privateFee ?? false,
        program: artifacts.source,
        ...importsSlice,
      });
      txId = await this.broadcastTransaction(tx);
    } else {
      const persistentExtras = await this.getPersistentExecutionOptions(
        nc,
        programId,
        transitionName,
        artifacts,
      );
      // Standard execution via ProgramManager
      txId = await pm.execute({
        programName: programId,
        functionName: transitionName,
        inputs: args,
        priorityFee: options?.fee ?? 0,
        privateFee: options?.privateFee ?? false,
        program: artifacts.source,
        ...importsSlice,
        ...(persistentExtras ?? {}),
      });
    }

    if (options?.awaitConfirmation !== true) {
      return { outputs: [], txId };
    }
    return this.getTransitionOutputs(txId, programId, transitionName);
  }

  async checkLocalExecution(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<void> {
    this.assertOpen();
    if (this.type === "devnode") {
      const { checkDevnodeSdkSupport, initConsensusHeights } = await import("./sdk-adapter.js");
      await checkDevnodeSdkSupport();
      await initConsensusHeights();
    }

    const { pm: effectivePm, nc: effectiveNc } = await this.getEffectivePm(
      options?.signer?.privateKey,
    );
    const pm = effectivePm as any;
    const nc = effectiveNc as any;

    if (typeof pm.buildAuthorizationUnchecked !== "function") {
      throw new Error(
        "Local failure checks require SDK ProgramManager.buildAuthorizationUnchecked().",
      );
    }

    const runtimeImports = this.collectRuntimeImports(programId, options?.imports);
    const artifacts = await resolveProgramExecutionArtifacts({
      artifactsDir: this.artifactsDir,
      programId,
      networkClient: nc,
      includeSidecar: true,
      runtimeImports,
    });

    try {
      await pm.buildAuthorizationUnchecked({
        programName: programId,
        functionName: transitionName,
        inputs: args,
        programSource: artifacts.source,
        ...(artifacts.imports === undefined ? {} : { programImports: artifacts.imports }),
      });
    } catch (error) {
      if (isCatchableLocalVmError(error)) {
        throw new LocalVmExecutionError(
          `Local VM execution failed for ${programId}/${transitionName}: ${errorMessage(error)}`,
          {
            programId,
            transitionName,
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  /**
   * Await confirmation of `txId` and return the parsed outputs for the
   * matching `(programId, transitionName)` transition. Used internally by
   * `execute()` when `awaitConfirmation: true`, and exposed as a public
   * follow-up for callers that opted into fire-and-forget broadcast.
   */
  async getTransitionOutputs(
    txId: string,
    programId: string,
    transitionName: string,
    timeout?: number,
  ): Promise<TransitionCallResult> {
    const confirmed = await this.waitForConfirmation(txId, timeout);
    if (confirmed.status === "rejected") {
      throw new TransitionRejectedError(
        `Transition ${programId}/${transitionName} was rejected on inclusion (txId ${txId}); rejected execute transactions are converted to fee-only and carry no transition outputs.`,
        {
          txId: confirmed.txId,
          programId,
          transitionName,
          blockHeight: confirmed.blockHeight,
        },
      );
    }
    const transition = selectMatchingTransition(
      programId,
      transitionName,
      confirmed.transitions,
      confirmed.txId,
    );
    const outputs = transition.rawOutputs.map(toOutputString);
    return {
      outputs,
      rawOutputs: transition.rawOutputs,
      txId: confirmed.txId,
    };
  }

  /**
   * Merge config-level and per-call runtime-import refs. Per-call entries
   * are normalized against `this.projectRoot`; path refs that don't exist
   * fail-fast here with a config-style error. Output is sorted and deduped
   * by `(kind, value)` for cache identity stability.
   */
  private collectRuntimeImports(
    programId: string,
    callRefs: readonly string[] | undefined,
  ): readonly RuntimeImportRef[] {
    const fromConfig = this.executionImports[programId] ?? [];
    const fromCall: RuntimeImportRef[] = [];
    for (const raw of callRefs ?? []) {
      const ref = normalizeRuntimeImportRef(raw, this.projectRoot);
      if (ref.kind === "path") {
        if (!fs.existsSync(ref.absolutePath)) {
          throw new Error(
            `Runtime import path not found: ${ref.absolutePath} (from per-call options.imports ${JSON.stringify(raw)})`,
          );
        }
      }
      fromCall.push(ref);
    }
    return dedupAndSortRuntimeImports([...fromConfig, ...fromCall]);
  }

  private async getPersistentExecutionOptions(
    nc: {
      getProgram(id: string): Promise<string>;
      getLatestProgramEdition?: (id: string) => Promise<number>;
    },
    programId: string,
    transitionName: string,
    artifacts: ProgramExecutionArtifacts,
  ): Promise<Record<string, unknown> | undefined> {
    if (this.keyCache?.storage !== "filesystem" || !this.keyCache.path) {
      return undefined;
    }

    const edition = await getLatestProgramEditionIfAvailable(nc, programId);
    const runtime = await import("./sdk-adapter.js");
    const sdkMetadata = runtime.getSdkRuntimeMetadata(this.networkId);
    const identity = buildRuntimeKeyIdentity({
      network: this.networkId,
      programId,
      transition: transitionName,
      edition,
      sourceHash: artifacts.sourceHash,
      importsHash: artifacts.importsHash,
      wasmHash: sdkMetadata.wasmHash,
    });

    const cached = findCachedExecutionKeys({
      cachePath: this.keyCache.path,
      identity,
      artifacts,
    });

    const keyBytes: { provingKeyBytes: Uint8Array; verifyingKeyBytes: Uint8Array } | undefined =
      cached;
    if (!keyBytes) {
      // Cache miss. Do not call the query-less WASM `synthesizeKeyPair` path:
      // direct PROBE-2 evidence showed `pm.execute` lazy synthesis stays on the
      // guarded CallbackQuery path, while eager synthesis cannot be transport
      // guarded. Cache hits above still inject keys.
      return edition === undefined ? undefined : { edition };
    }

    const keys = await runtime.createExecutionKeysFromBytes(this.networkId, {
      provingKey: keyBytes.provingKeyBytes,
      verifyingKey: keyBytes.verifyingKeyBytes,
    });

    return {
      ...(edition === undefined ? {} : { edition }),
      provingKey: keys.provingKey,
      verifyingKey: keys.verifyingKey,
    };
  }

  async waitForConfirmation(txId: string, timeout?: number): Promise<ConfirmedTransaction> {
    this.assertOpen();
    const effectiveTimeout = timeout ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    const deadline = Date.now() + effectiveTimeout;
    const fetchHeaders: Record<string, string> = {};
    if (this.apiKey) {
      fetchHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const base = `${this.endpoint}/${this.networkId}`;

    // Phase 1: poll /transaction/confirmed/<txId> until the tx is in a block.
    // This response no longer carries block_height; the height is fetched in
    // phase 2 via the two-step find/blockHash + block/<hash> lookup.
    const confirmUrl = `${base}/transaction/confirmed/${txId}`;
    let confirmedBody: Record<string, unknown> | null = null;
    while (Date.now() < deadline && confirmedBody === null) {
      let response: Response | null = null;
      try {
        response = await fetch(confirmUrl, { headers: fetchHeaders });
      } catch (err) {
        // Transient transport errors — retry until deadline.
        void err;
      }
      if (response?.ok) {
        // Body parse is fail-fast: a malformed JSON body after a 200 OK is a
        // protocol-level shape mismatch, not a transient retry. (A 200 OK
        // with parseable JSON but wrong shape is caught below by
        // parseConfirmedTransitions and also surfaces immediately.)
        try {
          confirmedBody = (await response.json()) as Record<string, unknown>;
        } catch (cause) {
          throw new TransactionShapeParseError(
            `Transaction ${txId} confirmed body is not valid JSON`,
            txId,
            "body",
            cause,
          );
        }
        break;
      }
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
    }
    if (confirmedBody === null) {
      throw new NetworkConfirmationTimeoutError(
        `Transaction ${txId} not confirmed within ${effectiveTimeout}ms`,
        { txId, timeout: effectiveTimeout, stage: "confirmed" },
      );
    }

    // In Aleo, rejected transactions are confirmed as fee-only.
    // Accepted: transaction.type is "execute" or "deploy". Rejected: "fee".
    const txData = confirmedBody["transaction"] as Record<string, unknown> | undefined;
    const txType = txData?.["type"] ?? confirmedBody["type"];
    const status: "accepted" | "rejected" = txType === "fee" ? "rejected" : "accepted";

    // Parse execute transitions. For fee-only rejected txs, the original
    // execute transitions are not carried by the chain, so transitions: [].
    // For accepted execute txs, missing/malformed transition data fails
    // fast (TransactionShapeParseError) rather than silently returning [].
    const transitions = parseConfirmedTransitions(txData, txId, txType);

    // Phase 2: resolve the containing block's height.
    //   step a: GET /<network>/find/blockHash/<txId>  -> JSON-encoded block hash
    //   step b: GET /<network>/block/<blockHash>      -> header.metadata.height
    // Both calls are bounded by the same deadline; transient errors retry.
    const blockHashUrl = `${base}/find/blockHash/${txId}`;
    let blockHash: string | null = null;
    while (Date.now() < deadline && blockHash === null) {
      try {
        const response = await fetch(blockHashUrl, { headers: fetchHeaders });
        if (response.ok) {
          const raw = (await response.text()).trim();
          // Body is a JSON-encoded string: `"ab1...."`
          if (raw.startsWith('"') && raw.endsWith('"')) {
            blockHash = JSON.parse(raw) as string;
          } else {
            blockHash = raw;
          }
          break;
        }
      } catch {
        // retry
      }
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
    }
    if (blockHash === null) {
      throw new NetworkConfirmationTimeoutError(
        `Transaction ${txId} confirmed but block-hash lookup did not resolve within ${effectiveTimeout}ms`,
        { txId, timeout: effectiveTimeout, stage: "blockHash" },
      );
    }

    const blockUrl = `${base}/block/${blockHash}`;
    let blockHeight: number | null = null;
    while (Date.now() < deadline && blockHeight === null) {
      try {
        const response = await fetch(blockUrl, { headers: fetchHeaders });
        if (response.ok) {
          const block = (await response.json()) as Record<string, unknown>;
          const header = block["header"] as Record<string, unknown> | undefined;
          const metadata = header?.["metadata"] as Record<string, unknown> | undefined;
          const h = metadata?.["height"];
          if (typeof h === "number") {
            blockHeight = h;
            break;
          }
          // Block returned 200 but no numeric header.metadata.height. This is
          // a hard parser disagreement, not transient — fail fast rather than
          // burning the deadline on a shape that won't change.
          throw new Error(
            `Transaction ${txId} confirmed at block ${blockHash} but header.metadata.height is missing or non-numeric`,
          );
        }
      } catch (err) {
        // Surface the explicit shape-mismatch immediately; only retry transient errors.
        if (err instanceof Error && err.message.includes("missing or non-numeric")) {
          throw err;
        }
        // retry on network/parse errors
      }
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
    }
    if (blockHeight === null) {
      throw new NetworkConfirmationTimeoutError(
        `Transaction ${txId} confirmed but block height could not be resolved within ${effectiveTimeout}ms`,
        { txId, timeout: effectiveTimeout, stage: "blockHeight" },
      );
    }

    return { txId, blockHeight, status, transitions };
  }

  // Assigned dynamically for devnode connections only
  advanceBlocks?: (count: number) => Promise<void>;

  async getBlockHeight(): Promise<number> {
    this.assertOpen();
    const sdk = await this.getSdkObjects();
    const nc = sdk.networkClient as any;
    const height: number = await nc.getLatestHeight();
    return height;
  }

  async getProgramSource(programId: string): Promise<string | null> {
    this.assertOpen();
    const sdk = await this.getSdkObjects();
    const nc = sdk.networkClient as any;

    try {
      const source: string | undefined = await nc.getProgram(programId);
      if (source === undefined || source === null) return null;
      return typeof source === "string" ? source : String(source);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("404") ||
        message.includes("not found") ||
        message.includes("Not Found") ||
        message.includes("500") // devnode returns 500 for non-existent programs
      ) {
        return null;
      }
      throw new Error(`Failed to fetch program source for "${programId}": ${message}`);
    }
  }

  async close(): Promise<void> {
    this._closed = true;

    // Destroy cached signer accounts
    for (const signerSdk of this.signerSdkResolved.values()) {
      tryDestroyAccount(signerSdk.account);
    }
    this.signerSdkResolved.clear();
    this.signerSdkInflight.clear();

    // Destroy default account if resolved
    if (this.sdkObjects) {
      tryDestroyAccount(this.sdkObjects.account);
    } else if (this.sdkObjectsPromise !== undefined) {
      // Pending — await and destroy
      try {
        const sdk = await this.sdkObjectsPromise;
        tryDestroyAccount(sdk.account);
      } catch {
        // Init failed — nothing to destroy
      }
    }

    this.sdkObjects = undefined;
    this.sdkObjectsPromise = undefined;
  }

  /** Broadcast a serialized transaction via the SDK network client. */
  async broadcastTransaction(transaction: unknown): Promise<string> {
    this.assertOpen();
    const sdk = await this.getSdkObjects();
    const nc = sdk.networkClient as any;
    const txId: string = await nc.submitTransaction(transaction);
    return typeof txId === "string" ? txId.replace(/"/g, "") : String(txId);
  }

  private async getDefaultAddress(): Promise<string> {
    if (this.privateKey) {
      const sdk = await this.getSdkObjects();
      const account = sdk.account as any;
      return typeof account.address === "function"
        ? account.address().to_string()
        : String(account.address ?? account);
    }
    throw new Error(
      "No address specified and no private key configured. " +
        "Pass an address or configure a private key in network config.",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupAndSortRuntimeImports(
  refs: readonly RuntimeImportRef[],
): readonly RuntimeImportRef[] {
  const seen = new Set<string>();
  const out: RuntimeImportRef[] = [];
  for (const ref of refs) {
    const key = ref.kind === "programId" ? `id:${ref.programId}` : `path:${ref.absolutePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  out.sort((a, b) => {
    const aKey = a.kind === "programId" ? a.programId : a.absolutePath;
    const bKey = b.kind === "programId" ? b.programId : b.absolutePath;
    if (aKey === bKey) return 0;
    return aKey < bKey ? -1 : 1;
  });
  return out;
}

async function getLatestProgramEditionIfAvailable(
  nc: { getLatestProgramEdition?: (id: string) => Promise<number> },
  programId: string,
): Promise<number | undefined> {
  if (typeof nc.getLatestProgramEdition !== "function") return undefined;
  try {
    const edition = await nc.getLatestProgramEdition(programId);
    return Number.isInteger(edition) && edition >= 0 ? edition : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Flatten a `RawTransitionOutput` to a string for the `outputs: string[]`
 * field of `TransitionCallResult`. Plain string entries pass through;
 * id-only dynamic-record outputs surface their `id`. The faithful shape is
 * preserved separately in `TransitionCallResult.rawOutputs`.
 */
function toOutputString(output: RawTransitionOutput): string {
  return typeof output === "string" ? output : output.id;
}

/** Best-effort destroy of an SDK Account to release WASM private-key state. */
function tryDestroyAccount(account: unknown): void {
  if (account && typeof (account as any).destroy === "function") {
    try {
      (account as any).destroy();
    } catch {
      // Non-fatal — some SDK versions may not support destroy
    }
  }
}

/**
 * Parse confirmed-transaction body into typed ConfirmedTransitionRecord[].
 *
 * Shape (accepted execute):
 *   transaction.execution.transitions[] with each entry having:
 *     program: "name.aleo", function: "func", outputs: [{type, id, value, ...}]
 *
 * Shape (rejected → fee-only / deploy):
 *   no `execution` field. Returns [].
 *
 * Throws TransactionShapeParseError on:
 *   - txType === "execute" with missing/malformed execution or transitions
 *     (would silently lose typed outputs otherwise)
 *   - any malformed transition entry (missing program/function, non-array
 *     outputs, output.value present but not a string)
 */
function parseConfirmedTransitions(
  txData: Record<string, unknown> | undefined,
  txId: string,
  outerTxType: unknown,
): ConfirmedTransitionRecord[] {
  // Strictness signal: the txData object itself self-identifies as
  // "execute". If only the outer body claims "execute" (legacy fallback) or
  // there's no transaction object at all, stay tolerant — there's nothing
  // to validate against.
  void outerTxType;
  if (!txData) return [];
  const isExecute = txData["type"] === "execute";

  const execution = txData["execution"] as Record<string, unknown> | undefined;
  if (!execution) {
    if (isExecute) {
      throw new TransactionShapeParseError(
        `Transaction ${txId}: type is "execute" but transaction.execution is missing.`,
        txId,
        "transaction.execution",
      );
    }
    return [];
  }

  const rawTransitions = execution["transitions"];
  if (rawTransitions === undefined || rawTransitions === null) {
    if (isExecute) {
      throw new TransactionShapeParseError(
        `Transaction ${txId}: type is "execute" but transaction.execution.transitions is missing.`,
        txId,
        "transaction.execution.transitions",
      );
    }
    return [];
  }
  if (!Array.isArray(rawTransitions)) {
    throw new TransactionShapeParseError(
      `Transaction ${txId}: transaction.execution.transitions is not an array (got ${typeof rawTransitions}).`,
      txId,
      "transaction.execution.transitions",
    );
  }

  return rawTransitions.map((entry, index) => parseTransition(entry, txId, index));
}

function parseTransition(entry: unknown, txId: string, index: number): ConfirmedTransitionRecord {
  const path = `transaction.execution.transitions[${index}]`;
  if (typeof entry !== "object" || entry === null) {
    throw new TransactionShapeParseError(
      `Transaction ${txId}: ${path} is not an object.`,
      txId,
      path,
    );
  }
  const obj = entry as Record<string, unknown>;
  const programId = obj["program"];
  if (typeof programId !== "string" || programId.length === 0) {
    throw new TransactionShapeParseError(
      `Transaction ${txId}: ${path}.program is missing or not a string.`,
      txId,
      `${path}.program`,
    );
  }
  const transitionName = obj["function"];
  if (typeof transitionName !== "string" || transitionName.length === 0) {
    throw new TransactionShapeParseError(
      `Transaction ${txId}: ${path}.function is missing or not a string.`,
      txId,
      `${path}.function`,
    );
  }
  const transitionPublicKey = obj["tpk"];
  if (typeof transitionPublicKey !== "string" || transitionPublicKey.length === 0) {
    throw new TransactionShapeParseError(
      `Transaction ${txId}: ${path}.tpk is missing or not a string. The transition public key is required to decrypt private inputs/outputs.`,
      txId,
      `${path}.tpk`,
    );
  }
  const rawOutputs = obj["outputs"];
  if (rawOutputs === undefined || rawOutputs === null) {
    // Transition with no outputs is valid (some transitions return nothing).
    return { programId, transitionName, rawOutputs: [], transitionPublicKey };
  }
  if (!Array.isArray(rawOutputs)) {
    throw new TransactionShapeParseError(
      `Transaction ${txId}: ${path}.outputs is not an array.`,
      txId,
      `${path}.outputs`,
    );
  }
  const outputValues: RawTransitionOutput[] = rawOutputs.map((output, outputIndex) => {
    if (typeof output !== "object" || output === null) {
      throw new TransactionShapeParseError(
        `Transaction ${txId}: ${path}.outputs[${outputIndex}] is not an object.`,
        txId,
        `${path}.outputs[${outputIndex}]`,
      );
    }
    const outputObject = output as Record<string, unknown>;
    if (!Object.hasOwn(outputObject, "value")) {
      const id = outputObject["id"];
      if (typeof id !== "string" || id.length === 0) {
        throw new TransactionShapeParseError(
          `Transaction ${txId}: ${path}.outputs[${outputIndex}] has no value and no string id.`,
          txId,
          `${path}.outputs[${outputIndex}].id`,
        );
      }
      const type = outputObject["type"];
      return {
        kind: "idOnly",
        id,
        type: typeof type === "string" && type.length > 0 ? type : "unknown",
      };
    }
    const value = outputObject["value"];
    if (typeof value !== "string") {
      throw new TransactionShapeParseError(
        `Transaction ${txId}: ${path}.outputs[${outputIndex}].value is not a string.`,
        txId,
        `${path}.outputs[${outputIndex}].value`,
      );
    }
    return value;
  });

  return { programId, transitionName, rawOutputs: outputValues, transitionPublicKey };
}

function extractLocalExecutionOutputs(result: unknown): string[] {
  if (Array.isArray(result)) {
    return result.map(String);
  }

  if (result && typeof result === "object") {
    const executionResponse = result as {
      getOutputs?: () => unknown;
      outputs?: unknown;
    };

    if (typeof executionResponse.getOutputs === "function") {
      const outputs = executionResponse.getOutputs();
      return Array.isArray(outputs) ? outputs.map(String) : [];
    }

    if (Array.isArray(executionResponse.outputs)) {
      return executionResponse.outputs.map(String);
    }
  }

  return [];
}

function isCatchableLocalVmError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.startsWith("Stack authorization failed:") ||
    message.startsWith("Stack evaluation failed:")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
