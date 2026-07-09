import type { AleoNetwork, NamedAccounts } from "@lionden/config";
import type {
  ConfirmedTransaction,
  ConfirmedTransitionRecord,
  DevnodeAccount,
  ExecuteOptions,
  NetworkConnection,
  NetworkManager,
  SdkEgressPolicy,
  TransitionCallResult,
} from "@lionden/network";
import {
  DEVNODE_ACCOUNTS,
  selectMatchingTransition,
  TransitionRejectedError,
} from "@lionden/network";
import { TEST_DEVNODE_EGRESS_POLICY } from "../test-egress-policy.js";

// ---------------------------------------------------------------------------
// Call recording
// ---------------------------------------------------------------------------

export interface FakeCall {
  method: string;
  args: unknown[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// FakeNetworkConnection
// ---------------------------------------------------------------------------

export interface FakeNetworkOptions {
  name?: string;
  endpoint?: string;
  networkId?: AleoNetwork;
  privateKey?: string;
  initialBalance?: bigint;
  initialBlockHeight?: number;
}

export class FakeNetworkConnection implements NetworkConnection {
  readonly type = "devnode" as const;
  readonly name: string;
  readonly endpoint: string;
  readonly networkId: AleoNetwork;
  readonly privateKey?: string;
  readonly egressPolicy: SdkEgressPolicy = TEST_DEVNODE_EGRESS_POLICY;
  closed = false;

  /** Recorded method calls for assertions. */
  readonly calls: FakeCall[] = [];

  private balances = new Map<string, bigint>();
  private defaultBalance: bigint;
  private mappings = new Map<string, Map<string, string>>();
  private storageValues = new Map<string, string>();
  private executeResponses = new Map<string, TransitionCallResult>();
  private defaultExecuteResponse: TransitionCallResult = {
    outputs: ["1u32"],
    txId: undefined,
  };
  private confirmBehavior: "accept" | "reject" = "accept";
  private blockHeight: number;
  private txCounter = 0;
  private programSources = new Map<string, string>();
  private programEditions = new Map<string, number>();
  // Per-txId memo of the execute that produced it. Keeps waitForConfirmation
  // returning a transitions[] entry that mirrors the originating execute,
  // so broadcast → decrypt round-trips against the fake work the same way
  // they do against devnode.
  private confirmedTransitionByTxId = new Map<string, ConfirmedTransitionRecord>();

  constructor(options: FakeNetworkOptions = {}) {
    this.name = options.name ?? "devnode";
    this.endpoint = options.endpoint ?? "http://127.0.0.1:3030";
    this.networkId = options.networkId ?? "testnet";
    this.privateKey = options.privateKey;
    this.defaultBalance = options.initialBalance ?? 1_000_000_000_000n;
    this.blockHeight = options.initialBlockHeight ?? 1;
  }

  // -------------------------------------------------------------------------
  // State control
  // -------------------------------------------------------------------------

  setBalance(address: string, balance: bigint): void {
    this.balances.set(address, balance);
  }

  setMappingValue(programId: string, mappingName: string, key: string, value: string): void {
    const mapKey = `${programId}:${mappingName}`;
    let mapping = this.mappings.get(mapKey);
    if (!mapping) {
      mapping = new Map();
      this.mappings.set(mapKey, mapping);
    }
    mapping.set(key, value);
  }

  clearMapping(programId: string, mappingName: string): void {
    this.mappings.delete(`${programId}:${mappingName}`);
  }

  setStorageValue(programId: string, variableName: string, value: string): void {
    this.storageValues.set(`${programId}:${variableName}`, value);
  }

  clearStorageValue(programId: string, variableName: string): void {
    this.storageValues.delete(`${programId}:${variableName}`);
  }

  setExecuteResponse(
    programId: string,
    transitionName: string,
    response: TransitionCallResult,
  ): void {
    this.executeResponses.set(`${programId}:${transitionName}`, response);
  }

  setDefaultExecuteResponse(response: TransitionCallResult): void {
    this.defaultExecuteResponse = response;
  }

  setConfirmBehavior(behavior: "accept" | "reject"): void {
    this.confirmBehavior = behavior;
  }

  setBlockHeight(height: number): void {
    this.blockHeight = height;
  }

  setProgramSource(programId: string, source: string): void {
    this.programSources.set(programId, source);
  }

  clearProgramSource(programId: string): void {
    this.programSources.delete(programId);
    this.programEditions.delete(programId);
  }

  setProgramEdition(programId: string, edition: number): void {
    this.programEditions.set(programId, edition);
  }

  // -------------------------------------------------------------------------
  // Call recording
  // -------------------------------------------------------------------------

  getCallsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  // -------------------------------------------------------------------------
  // NetworkConnection implementation
  // -------------------------------------------------------------------------

  async getBalance(address?: string): Promise<bigint> {
    this.calls.push({ method: "getBalance", args: [address], timestamp: Date.now() });
    const addr = address ?? "aleo1default";
    return this.balances.get(addr) ?? this.defaultBalance;
  }

  async getMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string | null> {
    this.calls.push({
      method: "getMappingValue",
      args: [programId, mappingName, key],
      timestamp: Date.now(),
    });
    const mapping = this.mappings.get(`${programId}:${mappingName}`);
    return mapping?.get(key) ?? null;
  }

  async getStorageValue(programId: string, variableName: string): Promise<string | null> {
    this.calls.push({
      method: "getStorageValue",
      args: [programId, variableName],
      timestamp: Date.now(),
    });
    return this.storageValues.get(`${programId}:${variableName}`) ?? null;
  }

  async getStorageVectorLength(programId: string, variableName: string): Promise<number> {
    this.calls.push({
      method: "getStorageVectorLength",
      args: [programId, variableName],
      timestamp: Date.now(),
    });
    const raw = await this.getMappingValue(programId, `${variableName}__len__`, "false");
    return raw === null ? 0 : Number(raw.replace(/u32(?:\.(?:public|private))?$/i, ""));
  }

  async getStorageVectorValue(
    programId: string,
    variableName: string,
    index: number,
  ): Promise<string | null> {
    this.calls.push({
      method: "getStorageVectorValue",
      args: [programId, variableName, index],
      timestamp: Date.now(),
    });
    return this.getMappingValue(programId, `${variableName}__`, `${index}u32`);
  }

  async execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<TransitionCallResult> {
    this.calls.push({
      method: "execute",
      args: [programId, transitionName, args, options],
      timestamp: Date.now(),
    });
    const key = `${programId}:${transitionName}`;
    const response = this.executeResponses.get(key) ?? this.defaultExecuteResponse;
    const txId = response.txId ?? `at1fake${this.txCounter++}`;
    this.blockHeight++;
    if (options?.mode === "local") {
      // Local mode: no broadcast, no confirmation, no memoization. Production
      // AleoConnection returns the SDK's local execution outputs here.
      return { outputs: response.outputs, txId };
    }
    // On-chain: memo the originating transition so waitForConfirmation /
    // getTransitionOutputs can mirror its outputs later.
    this.confirmedTransitionByTxId.set(txId, {
      programId,
      transitionName,
      rawOutputs: response.outputs,
      transitionPublicKey: "tpk_synthetic_" + txId,
    });
    if (options?.awaitConfirmation === true) {
      return this.getTransitionOutputs(txId, programId, transitionName);
    }
    // Fire-and-forget on-chain — mirror production AleoConnection.execute,
    // which returns outputs: [] when the caller didn't opt into awaiting.
    return { outputs: [], txId };
  }

  async getTransitionOutputs(
    txId: string,
    programId: string,
    transitionName: string,
    timeout?: number,
  ): Promise<TransitionCallResult> {
    this.calls.push({
      method: "getTransitionOutputs",
      args: [txId, programId, transitionName, timeout],
      timestamp: Date.now(),
    });
    const confirmed = await this.waitForConfirmation(txId, timeout);
    if (confirmed.status === "rejected") {
      throw new TransitionRejectedError(
        `Transition ${programId}/${transitionName} was rejected (fake; txId ${txId}).`,
        {
          txId: confirmed.txId,
          programId,
          transitionName,
          blockHeight: confirmed.blockHeight,
        },
      );
    }
    const transition = selectMatchingTransition(programId, transitionName, confirmed.transitions);
    const outputs = transition.rawOutputs.map((o) => (typeof o === "string" ? o : o.id));
    return {
      outputs,
      rawOutputs: transition.rawOutputs,
      txId: confirmed.txId,
    };
  }

  async waitForConfirmation(txId: string, timeout?: number): Promise<ConfirmedTransaction> {
    this.calls.push({
      method: "waitForConfirmation",
      args: [txId, timeout],
      timestamp: Date.now(),
    });
    const status = this.confirmBehavior === "accept" ? "accepted" : "rejected";
    // Rejected = fee-only on Aleo, so transitions[] is empty by convention.
    const transitions: ConfirmedTransitionRecord[] =
      status === "accepted"
        ? this.confirmedTransitionByTxId.has(txId)
          ? [this.confirmedTransitionByTxId.get(txId)!]
          : []
        : [];
    return {
      txId,
      blockHeight: this.blockHeight,
      status,
      transitions,
    };
  }

  async advanceBlocks(count: number): Promise<void> {
    this.calls.push({ method: "advanceBlocks", args: [count], timestamp: Date.now() });
    this.blockHeight += count;
  }

  async getBlockHeight(): Promise<number> {
    this.calls.push({ method: "getBlockHeight", args: [], timestamp: Date.now() });
    return this.blockHeight;
  }

  async getProgramSource(programId: string): Promise<string | null> {
    this.calls.push({ method: "getProgramSource", args: [programId], timestamp: Date.now() });
    return this.programSources.get(programId) ?? null;
  }

  async getProgramEdition(programId: string): Promise<number | null> {
    this.calls.push({ method: "getProgramEdition", args: [programId], timestamp: Date.now() });
    if (!this.programSources.has(programId)) return null;
    return this.programEditions.get(programId) ?? null;
  }

  async broadcastTransaction(transaction: unknown): Promise<string> {
    const txId = `at1fake${this.txCounter++}`;
    this.calls.push({
      method: "broadcastTransaction",
      args: [transaction],
      timestamp: Date.now(),
    });
    this.blockHeight++;
    return txId;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.calls.push({ method: "close", args: [], timestamp: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// FakeNetworkManager
// ---------------------------------------------------------------------------

export interface FakeNetworkManagerOptions {
  connection?: FakeNetworkConnection;
  accounts?: DevnodeAccount[];
  /**
   * Network names that connect() accepts. Defaults to `["devnode"]`.
   * Calling connect() with a name not in this list throws, matching
   * the production NetworkManagerImpl contract.
   */
  knownNetworks?: string[];
}

export class FakeNetworkManager implements NetworkManager {
  readonly connection: FakeNetworkConnection;
  private readonly accounts: DevnodeAccount[];
  private readonly knownNetworks: Set<string>;
  private activeConnection: FakeNetworkConnection | null = null;

  constructor(options: FakeNetworkManagerOptions = {}) {
    this.connection = options.connection ?? new FakeNetworkConnection();
    this.accounts = options.accounts ?? [...DEVNODE_ACCOUNTS];
    this.knownNetworks = new Set(options.knownNetworks ?? ["devnode"]);
  }

  async connect(name?: string): Promise<NetworkConnection> {
    const networkName = name ?? "devnode";
    if (!this.knownNetworks.has(networkName)) {
      const available = [...this.knownNetworks].join(", ");
      throw new Error(
        `Network "${networkName}" not found in config. Available: ${available || "none"}`,
      );
    }
    // Reset closed flag so reconnecting after disconnectAll() works,
    // matching production behavior where the manager creates a fresh connection.
    this.connection.closed = false;
    this.activeConnection = this.connection;
    return this.connection;
  }

  getConnection(): NetworkConnection | null {
    return this.activeConnection;
  }

  async disconnectAll(): Promise<void> {
    if (this.activeConnection) {
      await this.activeConnection.close();
    }
    this.activeConnection = null;
  }

  getAccounts(): DevnodeAccount[] {
    return this.accounts;
  }

  getNamedAccounts(): NamedAccounts {
    return {};
  }

  async execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<TransitionCallResult> {
    return this.requireConnection().execute(programId, transitionName, args, options);
  }

  async getMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string | null> {
    return this.requireConnection().getMappingValue(programId, mappingName, key);
  }

  async getStorageValue(programId: string, variableName: string): Promise<string | null> {
    return this.requireConnection().getStorageValue(programId, variableName);
  }

  async getStorageVectorLength(programId: string, variableName: string): Promise<number> {
    return this.requireConnection().getStorageVectorLength(programId, variableName);
  }

  async getStorageVectorValue(
    programId: string,
    variableName: string,
    index: number,
  ): Promise<string | null> {
    return this.requireConnection().getStorageVectorValue(programId, variableName, index);
  }

  async waitForConfirmation(txId: string, timeout?: number) {
    return this.requireConnection().waitForConfirmation(txId, timeout);
  }

  async getTransitionOutputs(
    txId: string,
    programId: string,
    transitionName: string,
    timeout?: number,
  ): Promise<TransitionCallResult> {
    return this.requireConnection().getTransitionOutputs(txId, programId, transitionName, timeout);
  }

  private requireConnection(): FakeNetworkConnection {
    if (!this.activeConnection) {
      throw new Error(
        "No active network connection. Call connect() first, or ensure " +
          "the network plugin has established a connection.",
      );
    }
    return this.activeConnection;
  }
}
