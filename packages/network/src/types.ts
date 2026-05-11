import type { AleoNetwork, NamedAccounts } from "@lionden/config";

// ---------------------------------------------------------------------------
// Transaction types
// ---------------------------------------------------------------------------

/**
 * Result from executing a program transition.
 * Shape matches the contract wrapper's TransitionCallResult.
 */
export interface TransitionCallResult {
  readonly outputs: string[];
  readonly txId?: string;
}

/** One confirmed transition within a confirmed transaction. */
export interface ConfirmedTransitionRecord {
  /** Program id, e.g. "token.aleo". */
  readonly programId: string;
  /** Transition name, e.g. "mint_private". */
  readonly transitionName: string;
  /**
   * Raw Leo-encoded output literals for this transition, in declaration order.
   * Record outputs are ciphertexts (`record1...`); plaintext outputs are
   * Leo literals (`123u32`, `aleo1...`, `{ ... }`, etc.).
   */
  readonly rawOutputs: readonly string[];
}

/** Confirmed transaction details. */
export interface ConfirmedTransaction {
  readonly txId: string;
  readonly blockHeight: number;
  readonly status: "accepted" | "rejected";
  /**
   * All execute transitions in the confirmed transaction.
   * For fee-only rejected transactions (Aleo converts rejected executes to
   * fee-only on inclusion), this is `[]` — the original execute transitions
   * are not carried by the chain.
   */
  readonly transitions: readonly ConfirmedTransitionRecord[];
}

export type ConfirmationTimeoutStage = "confirmed" | "blockHash" | "blockHeight";

export interface NetworkConfirmationTimeoutContext {
  readonly txId: string;
  readonly timeout: number;
  readonly stage: ConfirmationTimeoutStage;
  readonly cause?: unknown;
}

export class NetworkConfirmationTimeoutError extends Error {
  readonly kind = "NetworkConfirmationTimeoutError" as const;
  readonly txId: string;
  readonly timeout: number;
  readonly stage: ConfirmationTimeoutStage;

  constructor(message: string, context: NetworkConfirmationTimeoutContext) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "NetworkConfirmationTimeoutError";
    this.txId = context.txId;
    this.timeout = context.timeout;
    this.stage = context.stage;
  }
}

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------

/**
 * A signer that can authorize transactions.
 * DevnodeAccount satisfies this interface structurally.
 */
export interface Signer {
  readonly privateKey: string;
  readonly address: string;
}

/** Options for transition execution. */
export interface ExecuteOptions {
  mode?: "local" | "onchain";
  fee?: number;
  privateFee?: boolean;
  /** Override the signer for this execution. */
  signer?: Signer;
  /**
   * Generate real proofs during on-chain execution.
   * When false (default), devnode connections use the fast-path builder
   * (`buildDevnodeExecutionTransaction`) which skips proof generation.
   * When true, the standard `pm.execute()` path is used even on devnode,
   * producing real proofs (significantly slower).
   * Has no effect on non-devnode connections (proofs are always generated)
   * or in `"local"` mode.
   */
  prove?: boolean;
}

// ---------------------------------------------------------------------------
// Network connection
// ---------------------------------------------------------------------------

/**
 * A connection to an Aleo network node.
 * Provides typed methods for querying state and executing transitions.
 */
export interface NetworkConnection {
  /** Connection type */
  readonly type: "devnode" | "http";
  /** Name from config (e.g., "devnode", "testnet") */
  readonly name: string;
  /** REST API endpoint URL (e.g., "http://127.0.0.1:3030") */
  readonly endpoint: string;
  /** Aleo network ID */
  readonly networkId: AleoNetwork;
  /** Private key for signing, if configured. */
  readonly privateKey?: string;
  /** API key for explorer/node authentication. */
  readonly apiKey?: string;

  /** Get account balance in microcredits. Uses configured default account if none specified. */
  getBalance(address?: string): Promise<bigint>;

  /** Query a mapping value. Returns null if the key has no entry. */
  getMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string | null>;

  /** Execute a program transition. */
  execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<TransitionCallResult>;

  /** Wait for a transaction to be confirmed on-chain. */
  waitForConfirmation(
    txId: string,
    timeout?: number,
  ): Promise<ConfirmedTransaction>;

  /** Advance blocks on devnode. Only available on devnode connections. */
  advanceBlocks?(count: number): Promise<void>;

  /** Get the current block height. */
  getBlockHeight(): Promise<number>;

  /**
   * Fetch the compiled Aleo source for a deployed program.
   * Returns null if the program does not exist on-chain (404 / not found).
   */
  getProgramSource(programId: string): Promise<string | null>;

  /** Broadcast a serialized transaction to the network. Returns the transaction ID. */
  broadcastTransaction(transaction: unknown): Promise<string>;

  /** Whether this connection has been permanently closed. */
  readonly closed: boolean;

  /** Close this connection and release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Network manager
// ---------------------------------------------------------------------------

/**
 * Manages network connections for the LionDen runtime.
 * Created by plugin-network and injected into lre.network.
 */
export interface NetworkManager {
  /** Connect to a named network (or the default). */
  connect(name?: string): Promise<NetworkConnection>;

  /** Get the current active connection, or null if not connected. */
  getConnection(): NetworkConnection | null;

  /** Disconnect all active connections. */
  disconnectAll(): Promise<void>;

  /** Get well-known devnode accounts. */
  getAccounts(): DevnodeAccount[];

  /**
   * Get resolved named accounts for the currently active network.
   * Returns a shallow copy — mutating the returned object has no effect.
   * Returns {} before connect() or when no namedAccounts are configured.
   */
  getNamedAccounts(): NamedAccounts;

  /**
   * Execute a transition on the active connection.
   * Convenience method — delegates to getConnection().execute().
   */
  execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<TransitionCallResult>;

  /**
   * Query a mapping value on the active connection.
   * Convenience method — delegates to getConnection().getMappingValue().
   */
  getMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string | null>;

  /**
   * Wait for a transaction on the active connection.
   * Convenience method — delegates to getConnection().waitForConfirmation().
   */
  waitForConfirmation(
    txId: string,
    timeout?: number,
  ): Promise<ConfirmedTransaction>;
}

// ---------------------------------------------------------------------------
// Well-known devnode account
// ---------------------------------------------------------------------------

export interface DevnodeAccount {
  readonly name: string;
  readonly privateKey: string;
  readonly address: string;
  /** Initial balance in microcredits on devnode genesis (~23.4T) */
  readonly initialBalance: bigint;
}

// ---------------------------------------------------------------------------
// Devnode lifecycle
// ---------------------------------------------------------------------------

export interface DevnodeStartOptions {
  /** REST API socket address. Default: "127.0.0.1:3030" */
  socketAddr?: string;
  /** Auto-create blocks on transaction broadcast. Default: true */
  autoBlock?: boolean;
  /** Verbosity level (0-2). Default: 0 */
  verbosity?: number;
  /** Path to custom genesis block. */
  genesisPath?: string;
  /** Aleo network. Default: "testnet" */
  network?: AleoNetwork;
  /** Private key for the devnode validator. Default: well-known test key */
  privateKey?: string;
  /**
   * Path to the Leo CLI binary. Default: "leo".
   * Allows using a version-specific binary (e.g., "~/.leo/bin/leo-3.5").
   */
  leoBinary?: string;
  /**
   * Consensus heights for devnode startup (e.g., "0,1,2,3,4,5,6,7,8").
   * Required for V9/constructor support on devnode.
   */
  consensusHeights?: string;
}
