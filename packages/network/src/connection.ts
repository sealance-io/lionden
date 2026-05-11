/**
 * AleoConnection — concrete implementation of NetworkConnection.
 *
 * Delegates to the Provable SDK's AleoNetworkClient for queries and
 * transaction broadcasting, and to ProgramManager for transaction building.
 */

import type { AleoNetwork } from "@lionden/config";
import type { SdkObjects, SignerSdkObjects } from "./sdk-adapter.js";
import type {
  NetworkConnection,
  TransitionCallResult,
  ConfirmedTransaction,
  ExecuteOptions,
} from "./types.js";

export interface ConnectionOptions {
  type: "devnode" | "http";
  name: string;
  endpoint: string;
  networkId: AleoNetwork;
  privateKey?: string;
  /** API key for explorer/node authentication. */
  apiKey?: string;
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
            throw new Error(
              `Failed to advance block: ${response.status} ${response.statusText}`,
            );
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
  private async getEffectivePm(
    signerPrivateKey?: string,
  ): Promise<{ pm: unknown; nc: unknown }> {
    const defaultSdk = await this.getSdkObjects();

    if (!signerPrivateKey || signerPrivateKey === this.privateKey) {
      return { pm: defaultSdk.programManager, nc: defaultSdk.networkClient };
    }

    // Check resolved cache
    const resolved = this.signerSdkResolved.get(signerPrivateKey);
    if (resolved) {
      return { pm: resolved.programManager, nc: defaultSdk.networkClient };
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
    return { pm: signerSdk.programManager, nc: defaultSdk.networkClient };
  }

  async getBalance(address?: string): Promise<bigint> {
    this.assertOpen();
    const addr = address ?? await this.getDefaultAddress();
    const value = await this.getMappingValue(
      "credits.aleo",
      "account",
      addr,
    );
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
      if (message.includes("404") || message.includes("not found") || message.includes("Not Found")) {
        return null;
      }
      throw new Error(
        `Failed to query mapping ${programId}/${mappingName}: ${message}`,
      );
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
      const { checkDevnodeSdkSupport, initConsensusHeights } =
        await import("./sdk-adapter.js");
      // Enforce SDK v0.10.5 baseline for devnode operations
      await checkDevnodeSdkSupport();
      await initConsensusHeights();
    }

    // Resolve the effective ProgramManager — uses a per-signer isolated PM
    // when options.signer is provided, otherwise the connection's default.
    const { pm: effectivePm, nc: effectiveNc } = await this.getEffectivePm(
      options?.signer?.privateKey,
    );
    const pm = effectivePm as any;
    const mode = options?.mode ?? "onchain";

    if (mode === "local") {
      // Local execution — run without generating proofs.
      // SDK's run() expects the full program source code as first arg.
      // Fetch it from the node if we only have a program ID.
      const nc = effectiveNc as any;
      const programSource: string = await nc.getProgram(programId);

      // Fetch imported program sources for cross-program local execution.
      // The compiled Aleo source lists all transitive imports at the top;
      // pm.run() needs them as a Record<programId, source> in its 5th arg.
      const programImports =
        await fetchProgramImports(nc, programSource);

      const result = await pm.run(
        programSource,
        transitionName,
        args,
        false, // proveExecution = false
        programImports,
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

    if (useDevnodeFastPath) {
      // Devnode fast-path — skips proof generation
      const tx = await pm.buildDevnodeExecutionTransaction({
        programName: programId,
        functionName: transitionName,
        inputs: args,
        priorityFee: options?.fee ?? 0,
        privateFee: options?.privateFee ?? false,
      });
      txId = await this.broadcastTransaction(tx);
    } else {
      // Standard execution via ProgramManager
      txId = await pm.execute({
        programName: programId,
        functionName: transitionName,
        inputs: args,
        priorityFee: options?.fee ?? 0,
        privateFee: options?.privateFee ?? false,
      });
    }

    // TODO: Parse outputs from transaction once confirmed
    return { outputs: [], txId };
  }

  async waitForConfirmation(
    txId: string,
    timeout?: number,
  ): Promise<ConfirmedTransaction> {
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
      try {
        const response = await fetch(confirmUrl, { headers: fetchHeaders });
        if (response.ok) {
          confirmedBody = (await response.json()) as Record<string, unknown>;
          break;
        }
      } catch {
        // Not confirmed yet
      }
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
    }
    if (confirmedBody === null) {
      throw new Error(
        `Transaction ${txId} not confirmed within ${effectiveTimeout}ms`,
      );
    }

    // In Aleo, rejected transactions are confirmed as fee-only.
    // Accepted: transaction.type is "execute" or "deploy". Rejected: "fee".
    const txData = confirmedBody["transaction"] as
      | Record<string, unknown>
      | undefined;
    const txType = txData?.["type"] ?? confirmedBody["type"];
    const status: "accepted" | "rejected" =
      txType === "fee" ? "rejected" : "accepted";

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
      throw new Error(
        `Transaction ${txId} confirmed but block-hash lookup did not resolve within ${effectiveTimeout}ms`,
      );
    }

    const blockUrl = `${base}/block/${blockHash}`;
    let blockHeight: number | null = null;
    while (Date.now() < deadline && blockHeight === null) {
      try {
        const response = await fetch(blockUrl, { headers: fetchHeaders });
        if (response.ok) {
          const block = (await response.json()) as Record<string, unknown>;
          const header = block["header"] as
            | Record<string, unknown>
            | undefined;
          const metadata = header?.["metadata"] as
            | Record<string, unknown>
            | undefined;
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
        if (
          err instanceof Error &&
          err.message.includes("missing or non-numeric")
        ) {
          throw err;
        }
        // retry on network/parse errors
      }
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
    }
    if (blockHeight === null) {
      throw new Error(
        `Transaction ${txId} confirmed but block height could not be resolved within ${effectiveTimeout}ms`,
      );
    }

    return { txId, blockHeight, status };
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
      throw new Error(
        `Failed to fetch program source for "${programId}": ${message}`,
      );
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
    } else if (this.sdkObjectsPromise) {
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
 * Parse `import <name>.aleo;` declarations from compiled Aleo source and
 * fetch each imported program from the network.  The compiled format lists
 * all transitive imports at the top level, so no recursion is needed.
 *
 * Returns `undefined` when the program has no imports (avoids passing an
 * empty object to pm.run() which some SDK versions may not expect).
 */
async function fetchProgramImports(
  nc: { getProgram(id: string): Promise<string> },
  programSource: string,
): Promise<Record<string, string> | undefined> {
  const importPattern = /import\s+([\w]+\.aleo)\s*;/g;
  const importIds: string[] = [];
  let match;
  while ((match = importPattern.exec(programSource)) !== null) {
    importIds.push(match[1]!);
  }
  if (importIds.length === 0) return undefined;

  const sources = await Promise.all(
    importIds.map((id) => nc.getProgram(id)),
  );
  const imports: Record<string, string> = {};
  for (let i = 0; i < importIds.length; i++) {
    imports[importIds[i]!] = sources[i]!;
  }
  return imports;
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
