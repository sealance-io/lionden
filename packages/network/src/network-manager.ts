/**
 * NetworkManagerImpl — manages connections to Aleo networks.
 *
 * Injected into lre.network by @lionden/plugin-network.
 * Contract wrappers call execute(), getMappingValue(), and storage query helpers on this object.
 */

import type {
  LionDenResolvedConfig,
  NamedAccounts,
  ResolvedNetworkConfig,
  ResolvedSdkEgressConfig,
} from "@lionden/config";
import { DEVNODE_ACCOUNTS } from "./accounts.js";
import { AleoConnection } from "./connection.js";
import { NamedAccountManager } from "./named-account-manager.js";
import type { SdkEgressPolicy } from "./sdk-adapter.js";
import type {
  DevnodeAccount,
  ExecuteOptions,
  NetworkConnection,
  NetworkManager,
  TransitionCallResult,
} from "./types.js";

function resolveEgressPolicy(
  endpoint: string,
  override?: ResolvedSdkEgressConfig,
): SdkEgressPolicy {
  const endpointHost = (() => {
    try {
      return new URL(endpoint).host;
    } catch {
      return "";
    }
  })();

  const networkHosts = new Set<string>(endpointHost ? [endpointHost] : []);
  if (override?.networkHosts) {
    for (const h of override.networkHosts) networkHosts.add(h);
  }
  return {
    allowedNetworkHosts: networkHosts,
    violation: override?.violation ?? "block",
  };
}

export class NetworkManagerImpl implements NetworkManager {
  private readonly config: LionDenResolvedConfig;
  private activeConnection: NetworkConnection | null = null;
  private readonly connections = new Map<string, NetworkConnection>();
  private readonly namedAccountManager: NamedAccountManager;
  /** Per-network named account cache (survives connection close/reopen). */
  private readonly resolvedNamedAccountsCache = new Map<string, NamedAccounts>();
  private activeNamedAccounts: NamedAccounts = {};

  constructor(config: LionDenResolvedConfig) {
    this.config = config;
    this.namedAccountManager = new NamedAccountManager(config.namedAccounts);
  }

  async connect(name?: string): Promise<NetworkConnection> {
    const networkName = name ?? this.config.defaultNetwork;
    const networkConfig = this.config.networks[networkName];

    if (!networkConfig) {
      const available = Object.keys(this.config.networks).join(", ");
      throw new Error(
        `Network "${networkName}" not found in config. Available: ${available || "none"}`,
      );
    }

    // Return existing connection if already connected and not closed
    const existing = this.connections.get(networkName);
    if (existing) {
      if (existing.closed) {
        this.connections.delete(networkName);
        // Fall through to create a new connection below
      } else {
        this.activeConnection = existing;
        // Restore named accounts from per-network cache
        const cachedAccounts = this.resolvedNamedAccountsCache.get(networkName);
        this.activeNamedAccounts = cachedAccounts ?? {};
        return existing;
      }
    }

    // Create new connection first (may throw)
    const connection = this.createConnection(networkName, networkConfig);

    // Resolve named accounts — if this throws, close only the new connection
    // and preserve the previous active state (transactional).
    let resolvedAccounts: NamedAccounts;
    try {
      resolvedAccounts = await this.namedAccountManager.resolveForNetwork({
        networkName,
        networkType: networkConfig.type,
        networkId: networkConfig.network,
        endpoint: connection.endpoint,
        apiKey: networkConfig.type === "http" ? networkConfig.apiKey : undefined,
        egressPolicy: connection.egressPolicy,
      });
    } catch (err) {
      await connection.close().catch(() => {});
      throw err;
    }

    // Both connection creation and named-account resolution succeeded — swap state.
    this.connections.set(networkName, connection);
    this.activeConnection = connection;
    this.resolvedNamedAccountsCache.set(networkName, resolvedAccounts);
    this.activeNamedAccounts = resolvedAccounts;

    return connection;
  }

  getConnection(): NetworkConnection | null {
    return this.activeConnection;
  }

  async disconnectAll(): Promise<void> {
    const conns = [...this.connections.values()];
    this.connections.clear();
    this.activeConnection = null;
    this.activeNamedAccounts = {};
    this.resolvedNamedAccountsCache.clear();
    this.namedAccountManager.invalidate();

    await Promise.all(conns.map((c) => c.close()));
  }

  getAccounts(): DevnodeAccount[] {
    return [...DEVNODE_ACCOUNTS];
  }

  getNamedAccounts(): NamedAccounts {
    return { ...this.activeNamedAccounts };
  }

  async execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<TransitionCallResult> {
    const conn = this.requireConnection();
    return conn.execute(programId, transitionName, args, options);
  }

  async checkLocalExecution(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<void> {
    const conn = this.requireConnection() as NetworkConnection & {
      checkLocalExecution?: (
        programId: string,
        transitionName: string,
        args: string[],
        options?: ExecuteOptions,
      ) => Promise<void>;
    };
    if (typeof conn.checkLocalExecution !== "function") {
      throw new Error("Active network connection does not support local execution checks.");
    }
    return conn.checkLocalExecution(programId, transitionName, args, options);
  }

  async getMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string | null> {
    const conn = this.requireConnection();
    return conn.getMappingValue(programId, mappingName, key);
  }

  async getStorageValue(programId: string, variableName: string): Promise<string | null> {
    const conn = this.requireConnection();
    return conn.getStorageValue(programId, variableName);
  }

  async getStorageVectorLength(programId: string, variableName: string): Promise<number> {
    const conn = this.requireConnection();
    return conn.getStorageVectorLength(programId, variableName);
  }

  async getStorageVectorValue(
    programId: string,
    variableName: string,
    index: number,
  ): Promise<string | null> {
    const conn = this.requireConnection();
    return conn.getStorageVectorValue(programId, variableName, index);
  }

  async waitForConfirmation(txId: string, timeout?: number) {
    const conn = this.requireConnection();
    return conn.waitForConfirmation(txId, timeout);
  }

  async getTransitionOutputs(
    txId: string,
    programId: string,
    transitionName: string,
    timeout?: number,
  ) {
    const conn = this.requireConnection();
    return conn.getTransitionOutputs(txId, programId, transitionName, timeout);
  }

  private requireConnection(): NetworkConnection {
    if (!this.activeConnection) {
      throw new Error(
        "No active network connection. Call connect() first, or ensure " +
          "the network plugin has established a connection.",
      );
    }
    return this.activeConnection;
  }

  private createConnection(name: string, config: ResolvedNetworkConfig): NetworkConnection {
    const egressOverride = this.config.sdk.egress;
    switch (config.type) {
      case "devnode": {
        const endpoint = `http://${config.socketAddr}`;
        // Use the first configured account, or fall back to well-known account-0
        const privateKey =
          config.accounts.length > 0
            ? config.accounts[0]!.privateKey
            : DEVNODE_ACCOUNTS[0]!.privateKey;
        return new AleoConnection({
          type: "devnode",
          name,
          endpoint,
          networkId: config.network,
          privateKey,
          artifactsDir: this.config.paths.artifacts,
          keyCache: this.config.sdk.keyCache,
          logLevel: this.config.sdk.logLevel,
          egressPolicy: resolveEgressPolicy(endpoint, egressOverride),
          projectRoot: this.config.paths.root,
          executionImports: this.config.execution.imports,
        });
      }
      case "http": {
        return new AleoConnection({
          type: "http",
          name,
          endpoint: config.endpoint,
          networkId: config.network,
          privateKey: config.privateKey,
          apiKey: config.apiKey,
          artifactsDir: this.config.paths.artifacts,
          keyCache: this.config.sdk.keyCache,
          logLevel: this.config.sdk.logLevel,
          egressPolicy: resolveEgressPolicy(config.endpoint, egressOverride),
          projectRoot: this.config.paths.root,
          executionImports: this.config.execution.imports,
        });
      }
    }
  }
}
