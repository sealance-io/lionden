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
      // Enforce SDK v0.10.2 baseline for devnode operations
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

    // Poll the node REST API directly — the raw JSON response includes
    // block_height which is not part of the SDK's typed TransactionJSON.
    const url = `${this.endpoint}/${this.networkId}/transaction/confirmed/${txId}`;
    const deadline = Date.now() + effectiveTimeout;
    const fetchHeaders: Record<string, string> = {};
    if (this.apiKey) {
      fetchHeaders["Authorization"] = `Bearer ${this.apiKey}`;
    }

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { headers: fetchHeaders });
        if (response.ok) {
          const data = (await response.json()) as Record<string, unknown>;
          const height =
            typeof data["block_height"] === "number"
              ? data["block_height"]
              : 0;
          // In Aleo, rejected transactions are confirmed as fee-only.
          // Accepted: type is "execute" or "deploy". Rejected: type is "fee".
          const txData = data["transaction"] as
            | Record<string, unknown>
            | undefined;
          const txType = txData?.["type"] ?? data["type"];
          const status: "accepted" | "rejected" =
            txType === "fee" ? "rejected" : "accepted";
          return {
            txId,
            blockHeight: height as number,
            status,
          };
        }
      } catch {
        // Not confirmed yet
      }
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Transaction ${txId} not confirmed within ${effectiveTimeout}ms`,
    );
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
