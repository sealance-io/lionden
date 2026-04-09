/**
 * AleoConnection — concrete implementation of NetworkConnection.
 *
 * Delegates to the Provable SDK's AleoNetworkClient for queries and
 * transaction broadcasting, and to ProgramManager for transaction building.
 */

import type { AleoNetwork } from "@lionden/config";
import type { SdkObjects } from "./sdk-adapter.js";
import type {
  NetworkConnection,
  TransitionCallResult,
  ConfirmedTransaction,
  ExecuteOptions,
} from "./types.js";

export interface ConnectionOptions {
  type: "devnode" | "devnet" | "http";
  name: string;
  endpoint: string;
  networkId: AleoNetwork;
  privateKey?: string;
}

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;
const CONFIRMATION_POLL_INTERVAL_MS = 1_000;

export class AleoConnection implements NetworkConnection {
  readonly type: "devnode" | "devnet" | "http";
  readonly name: string;
  readonly endpoint: string;
  readonly networkId: AleoNetwork;
  readonly privateKey?: string;

  private sdkObjects?: SdkObjects;
  private sdkObjectsPromise?: Promise<SdkObjects>;

  constructor(options: ConnectionOptions) {
    this.type = options.type;
    this.name = options.name;
    this.endpoint = options.endpoint;
    this.networkId = options.networkId;
    this.privateKey = options.privateKey;

    // Devnode connections support block advancement
    if (this.type === "devnode") {
      this.advanceBlocks = async (count: number) => {
        for (let i = 0; i < count; i++) {
          const url = `${this.endpoint}/${this.networkId}/block/advance`;
          const response = await fetch(url, { method: "POST" });
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
    if (this.sdkObjects) return this.sdkObjects;

    if (!this.sdkObjectsPromise) {
      this.sdkObjectsPromise = (async () => {
        const { createSdkObjects } = await import("./sdk-adapter.js");
        const objects = await createSdkObjects(
          this.networkId,
          this.endpoint,
          this.privateKey,
        );
        this.sdkObjects = objects;
        return objects;
      })();
    }

    return this.sdkObjectsPromise;
  }

  async getBalance(address?: string): Promise<bigint> {
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
    if (this.type === "devnode") {
      const { checkDevnodeSdkSupport, initConsensusHeights } =
        await import("./sdk-adapter.js");
      // Enforce SDK v0.10.1 baseline for devnode operations
      await checkDevnodeSdkSupport();
      await initConsensusHeights();
    }

    const sdk = await this.getSdkObjects();
    const pm = sdk.programManager as any;
    const mode = options?.mode ?? "onchain";

    if (mode === "local") {
      // Local execution — run without generating proofs
      const result = await pm.run(
        programId,
        transitionName,
        args,
        false, // proveExecution = false
      );
      return {
        outputs: Array.isArray(result) ? result.map(String) : [],
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
        programId,
        functionName: transitionName,
        inputs: args,
        fee: options?.fee ?? 0,
        privateFee: options?.privateFee ?? false,
      });
      txId = await this.broadcastTransaction(tx);
    } else {
      // Standard execution via ProgramManager
      txId = await pm.execute({
        programId,
        functionName: transitionName,
        inputs: args,
        fee: options?.fee ?? 0,
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
    const sdk = await this.getSdkObjects();
    const nc = sdk.networkClient as any;
    const effectiveTimeout = timeout ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;

    try {
      const result = await nc.getTransaction(txId);
      if (result) {
        const height =
          typeof result["block_height"] === "number"
            ? result["block_height"]
            : 0;
        return { txId, blockHeight: height as number, status: "accepted" };
      }
    } catch {
      // Not confirmed yet — fall through to polling
    }

    // Poll until confirmed
    const deadline = Date.now() + effectiveTimeout;
    while (Date.now() < deadline) {
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
      try {
        const result = await nc.getTransaction(txId);
        if (result) {
          const height =
            typeof result["block_height"] === "number"
              ? result["block_height"]
              : 0;
          return { txId, blockHeight: height as number, status: "accepted" };
        }
      } catch {
        // Not confirmed yet
      }
    }

    throw new Error(
      `Transaction ${txId} not confirmed within ${effectiveTimeout}ms`,
    );
  }

  // Assigned dynamically for devnode connections only
  advanceBlocks?: (count: number) => Promise<void>;

  async getBlockHeight(): Promise<number> {
    const sdk = await this.getSdkObjects();
    const nc = sdk.networkClient as any;
    const height: number = await nc.getLatestHeight();
    return height;
  }

  async close(): Promise<void> {
    this.sdkObjects = undefined;
    this.sdkObjectsPromise = undefined;
  }

  /** Broadcast a serialized transaction via the SDK network client. */
  async broadcastTransaction(transaction: unknown): Promise<string> {
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
