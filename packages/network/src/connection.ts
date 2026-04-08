/**
 * AleoConnection — concrete implementation of NetworkConnection.
 *
 * Uses the Aleo REST API for queries (block height, mappings, balance)
 * and delegates transaction execution to the SDK adapter when available.
 */

import type { AleoNetwork } from "@lionden/config";
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
  private readonly privateKey?: string;

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
    const url =
      `${this.endpoint}/${this.networkId}/program/${encodeURIComponent(programId)}` +
      `/mapping/${encodeURIComponent(mappingName)}/${encodeURIComponent(key)}`;

    const response = await fetch(url);

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(
        `Failed to query mapping ${programId}/${mappingName}: ` +
          `${response.status} ${response.statusText}`,
      );
    }

    const text = await response.text();
    // REST API returns JSON-encoded string or null
    try {
      const parsed = JSON.parse(text) as string | null;
      return parsed;
    } catch {
      return text.trim() || null;
    }
  }

  async execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<TransitionCallResult> {
    const { createSdkObjects, initConsensusHeights, checkDevnodeSdkSupport } =
      await import("./sdk-adapter.js");

    if (this.type === "devnode") {
      // Enforce SDK v0.10.1 baseline for devnode operations
      await checkDevnodeSdkSupport();
      await initConsensusHeights();
    }

    const sdk = await createSdkObjects(
      this.networkId,
      this.endpoint,
      this.privateKey,
    );

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

    if (this.type === "devnode" && typeof pm.buildDevnodeExecutionTransaction === "function") {
      // Use devnode-specific builder
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
    const deadline = Date.now() + (timeout ?? DEFAULT_CONFIRMATION_TIMEOUT_MS);
    const url = `${this.endpoint}/${this.networkId}/transaction/${txId}`;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const data = (await response.json()) as Record<string, unknown>;
          const height =
            typeof data["block_height"] === "number"
              ? data["block_height"]
              : 0;
          return {
            txId,
            blockHeight: height as number,
            status: "accepted",
          };
        }
      } catch {
        // Not confirmed yet
      }
      await sleep(CONFIRMATION_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Transaction ${txId} not confirmed within ${timeout ?? DEFAULT_CONFIRMATION_TIMEOUT_MS}ms`,
    );
  }

  // Assigned dynamically for devnode connections only
  advanceBlocks?: (count: number) => Promise<void>;

  async getBlockHeight(): Promise<number> {
    const url = `${this.endpoint}/${this.networkId}/block/height/latest`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to get block height: ${response.status} ${response.statusText}`,
      );
    }

    const text = await response.text();
    return Number(text);
  }

  async close(): Promise<void> {
    // No persistent connection to close for REST-based connections
  }

  /** Broadcast a serialized transaction. */
  private async broadcastTransaction(transaction: unknown): Promise<string> {
    const url = `${this.endpoint}/${this.networkId}/transaction/broadcast`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(transaction),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to broadcast transaction: ${response.status} ${text.slice(0, 200)}`,
      );
    }

    return (await response.text()).replace(/"/g, "");
  }

  private async getDefaultAddress(): Promise<string> {
    if (this.privateKey) {
      // Would derive address from private key via SDK
      // For now, return a placeholder — real impl uses Account.from_private_key()
      const { createSdkObjects } = await import("./sdk-adapter.js");
      const sdk = await createSdkObjects(
        this.networkId,
        this.endpoint,
        this.privateKey,
      );
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
