import type {
  NetworkConnection,
  NetworkManager,
  TransitionCallResult,
  ConfirmedTransaction,
  ExecuteOptions,
  DevnodeAccount,
} from "@lionden/network";
import type { AleoNetwork } from "@lionden/config";
import { DEVNODE_ACCOUNTS } from "@lionden/network";

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
  closed = false;

  /** Recorded method calls for assertions. */
  readonly calls: FakeCall[] = [];

  private balances = new Map<string, bigint>();
  private defaultBalance: bigint;
  private mappings = new Map<string, Map<string, string>>();
  private executeResponses = new Map<string, TransitionCallResult>();
  private defaultExecuteResponse: TransitionCallResult = {
    outputs: ["1u32"],
    txId: undefined,
  };
  private confirmBehavior: "accept" | "reject" = "accept";
  private blockHeight: number;
  private txCounter = 0;

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

  setMappingValue(
    programId: string,
    mappingName: string,
    key: string,
    value: string,
  ): void {
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
    return { outputs: response.outputs, txId };
  }

  async waitForConfirmation(
    txId: string,
    timeout?: number,
  ): Promise<ConfirmedTransaction> {
    this.calls.push({
      method: "waitForConfirmation",
      args: [txId, timeout],
      timestamp: Date.now(),
    });
    return {
      txId,
      blockHeight: this.blockHeight,
      status: this.confirmBehavior === "accept" ? "accepted" : "rejected",
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
