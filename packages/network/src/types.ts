import type { AleoNetwork } from "@lionden/config";

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

/** Confirmed transaction details. */
export interface ConfirmedTransaction {
  readonly txId: string;
  readonly blockHeight: number;
  readonly status: "accepted" | "rejected";
}

/** Options for transition execution. */
export interface ExecuteOptions {
  mode?: "local" | "onchain";
  fee?: number;
  privateFee?: boolean;
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
  readonly type: "devnode" | "devnet" | "http";
  /** Name from config (e.g., "devnode", "testnet") */
  readonly name: string;
  /** REST API endpoint URL (e.g., "http://127.0.0.1:3030") */
  readonly endpoint: string;
  /** Aleo network ID */
  readonly networkId: AleoNetwork;

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
}
