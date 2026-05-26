import type { AleoNetwork, NamedAccounts } from "@lionden/config";
import type { SdkEgressPolicy } from "./sdk-adapter.js";

// ---------------------------------------------------------------------------
// Transaction types
// ---------------------------------------------------------------------------

/**
 * Result from executing a program transition at the network layer.
 *
 * - `outputs` is always present. In local mode it carries the SDK's local
 *   execution outputs. In on-chain mode it is `[]` unless the caller opted
 *   in to awaiting confirmation (`ExecuteOptions.awaitConfirmation === true`
 *   or `getTransitionOutputs(...)` was called), in which case it carries the
 *   matching transition's `rawOutputs` flattened to strings (id-only entries
 *   are serialized to their `id` so the common case stays `string[]`).
 * - `rawOutputs` is present only on the awaited on-chain path. It preserves
 *   the faithful on-chain shape, including the `idOnly` discriminator for
 *   dynamic-record outputs.
 *
 * Generated typechain wrappers consume this result (via `executeRaw`) but
 * surface their own typed output shape on top of `rawOutputs`; their public
 * return type is not this interface.
 */
export interface TransitionCallResult {
  readonly outputs: string[];
  readonly rawOutputs?: readonly RawTransitionOutput[];
  readonly txId?: string;
}

export interface IdOnlyTransitionOutput {
  readonly kind: "idOnly";
  readonly type: string;
  readonly id: string;
}

export type RawTransitionOutput = string | IdOnlyTransitionOutput;

/** One confirmed transition within a confirmed transaction. */
export interface ConfirmedTransitionRecord {
  /** Program id, e.g. "token.aleo". */
  readonly programId: string;
  /** Transition name, e.g. "mint_private". */
  readonly transitionName: string;
  /**
   * Raw outputs for this transition, in declaration order. Record outputs are
   * record ciphertexts (`record1...`) when the node exposes a value. Id-only
   * dynamic-record outputs are represented as `{ kind: "idOnly", ... }` so
   * ABI positions remain stable for generated projectors. Plaintext outputs
   * are Leo literals (`123u32`, `aleo1...`, `{ ... }`, etc.) only when
   * declared `public`; private and default-private plaintext outputs are Aleo
   * value ciphertexts (`ciphertext1...`) that callers must decrypt using the
   * transition's `transitionPublicKey` and the recipient's view key (see the
   * generated typechain's `EncryptedValue<T>` handles).
   */
  readonly rawOutputs: readonly RawTransitionOutput[];
  /**
   * Transition public key (`tpk`) carried by the on-chain transition. Required
   * input to `Ciphertext.decryptWithTransitionInfo(...)` when decrypting
   * private input or output ciphertexts produced by this transition.
   */
  readonly transitionPublicKey: string;
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

export interface TransitionRejectedContext {
  readonly txId: string;
  readonly programId: string;
  readonly transitionName: string;
  readonly blockHeight: number;
}

/**
 * Thrown by `connection.getTransitionOutputs(...)` (and by `execute(...)`
 * when `awaitConfirmation: true`) if the confirmed transaction landed with
 * `status: "rejected"`. Rejected execute transactions are converted to
 * fee-only on inclusion, so the original transition outputs are not
 * recoverable from the chain.
 */
export class TransitionRejectedError extends Error {
  readonly kind = "TransitionRejectedError" as const;
  readonly txId: string;
  readonly programId: string;
  readonly transitionName: string;
  readonly blockHeight: number;

  constructor(message: string, context: TransitionRejectedContext) {
    super(message);
    this.name = "TransitionRejectedError";
    this.txId = context.txId;
    this.programId = context.programId;
    this.transitionName = context.transitionName;
    this.blockHeight = context.blockHeight;
  }
}

export interface TransitionSelectionContext {
  readonly programId: string;
  readonly transitionName: string;
  readonly matchCount: number;
  readonly availableTransitions: readonly string[];
  /**
   * Present when the selector is invoked downstream of a successful broadcast
   * (e.g. via `connection.execute({ awaitConfirmation: true })` or
   * `connection.getTransitionOutputs(...)`). Callers that hit the reentrant
   * multi-match case need this id to look up the full confirmed transaction.
   */
  readonly txId?: string;
}

/**
 * Thrown by `selectMatchingTransition(...)` when the confirmed transaction
 * does not contain exactly one transition matching `(programId, transitionName)`.
 * Reentrant and recursive flows hit the multi-match case — opt out of the
 * default await via `{ awaitConfirmation: false }` and inspect
 * `connection.waitForConfirmation(txId).transitions` directly.
 */
export class TransitionSelectionError extends Error {
  readonly kind = "TransitionSelectionError" as const;
  readonly programId: string;
  readonly transitionName: string;
  readonly matchCount: number;
  readonly availableTransitions: readonly string[];
  readonly txId?: string;

  constructor(message: string, context: TransitionSelectionContext) {
    super(message);
    this.name = "TransitionSelectionError";
    this.programId = context.programId;
    this.transitionName = context.transitionName;
    this.matchCount = context.matchCount;
    this.availableTransitions = context.availableTransitions;
    this.txId = context.txId;
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
  /**
   * Additional programs to load into the VM at execute time. Each entry is
   * a Leo program id (bare `voting_power` or `voting_power.aleo`) or a path
   * to a local `.aleo` file (relative paths anchor to project root).
   * Merged with config-level `execution.imports[programId]` for this call.
   * Required when the program performs dynamic dispatch and the targets
   * cannot be discovered from static `import` statements.
   */
  imports?: readonly string[];
  /**
   * On-chain mode only. When `true`, `execute()` awaits confirmation and
   * returns the matching transition's parsed outputs. When `false` or
   * omitted, `execute()` returns immediately after broadcast with
   * `outputs: []`; callers can fetch outputs later via
   * `connection.getTransitionOutputs(txId, programId, transitionName)`.
   *
   * Defaults to `false` at this layer to preserve fire-and-forget semantics
   * for generated typechain `submitTransition()`, which calls
   * `network.execute(...)` and runs its own `waitForConfirmation` for
   * `.accepted()` / `.settled()`. The user-facing wrappers
   * (`ctx.execute`, `ctx.raw.execute`, recipe `execute`) flip the default
   * to `true` at their layer.
   *
   * No effect in `mode: "local"` (local mode returns outputs synchronously).
   */
  awaitConfirmation?: boolean;
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
  /**
   * SDK egress policy resolved for this connection. Plugins that build
   * their own SDK objects (deploy / upgrade / preflight) must forward
   * this into `createSdkObjects` so the same transports are installed.
   */
  readonly egressPolicy: SdkEgressPolicy;

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

  /**
   * Await confirmation of `txId` and return the parsed outputs for the
   * matching `(programId, transitionName)` transition.
   *
   * Throws `TransitionRejectedError` if the confirmed transaction has
   * `status: "rejected"` (fee-only on inclusion; outputs are not recoverable).
   * Throws `TransitionSelectionError` if the confirmed transaction does not
   * contain exactly one matching transition — see the error message for the
   * reentrant escape hatch (`awaitConfirmation: false` + manual
   * `waitForConfirmation(txId)`).
   */
  getTransitionOutputs(
    txId: string,
    programId: string,
    transitionName: string,
    timeout?: number,
  ): Promise<TransitionCallResult>;

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

  /**
   * Fetch parsed outputs for a confirmed transition on the active connection.
   * Convenience method — delegates to getConnection().getTransitionOutputs().
   */
  getTransitionOutputs(
    txId: string,
    programId: string,
    transitionName: string,
    timeout?: number,
  ): Promise<TransitionCallResult>;
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

/**
 * How `DevnodeManager` handles the devnode subprocess's stdout/stderr.
 *
 * - `"quiet-buffered"` (default): drain both streams, retain the last ~64 KiB
 *   per stream in an internal ring buffer. The buffered tail is surfaced in
 *   error messages on health-check timeout / unexpected exit and is readable
 *   via `getLogTail()`.
 * - `"inherit"`: pass stdout/stderr straight through to the parent process.
 *   No JS-side capture; `getLogTail()` returns empty strings.
 * - `"forward"`: drain in JS, invoke `onStdout` / `onStderr` per chunk, AND
 *   retain the same 64 KiB ring buffer.
 */
export type DevnodeLogMode = "quiet-buffered" | "inherit" | "forward";

/** Which devnode backend to drive. */
export type DevnodeProvider = "leo" | "standalone";

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
   * Required for V9/constructor support on the Leo backend. Rejected on the
   * standalone backend (consensus heights are compiled into `aleo-devnode`).
   */
  consensusHeights?: string;
  /**
   * Devnode backend. `"leo"` spawns `leo devnode start`; `"standalone"` spawns
   * Provable's `aleo-devnode start`. Default: `"leo"` (backward compatible).
   * Callers typically resolve this via `resolveDevnodeBackend` before start.
   */
  provider?: DevnodeProvider;
  /**
   * Path to the standalone `aleo-devnode` binary. Default: `"aleo-devnode"`.
   * Only used when `provider === "standalone"`.
   */
  devnodeBinary?: string;
  /**
   * Persistent ledger directory for the standalone backend (`--storage`).
   * Required for snapshot/restore. Standalone-only.
   */
  storagePath?: string;
  /** Clear `storagePath` before starting (`--clear-storage`). Standalone-only. */
  clearStorage?: boolean;
  /**
   * How to handle the devnode subprocess's stdout/stderr. Default:
   * `"quiet-buffered"`. The `LIONDEN_DEVNODE_LOGS` env var overrides the
   * default but never overrides an explicit caller-supplied value.
   */
  logMode?: DevnodeLogMode;
  /** Per-chunk stdout callback. Invoked only when `logMode === "forward"`. */
  onStdout?: (chunk: Buffer) => void;
  /** Per-chunk stderr callback. Invoked only when `logMode === "forward"`. */
  onStderr?: (chunk: Buffer) => void;
}
