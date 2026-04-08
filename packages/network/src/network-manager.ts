/**
 * NetworkManagerImpl — manages connections to Aleo networks.
 *
 * Injected into lre.network by @lionden/plugin-network.
 * Contract wrappers call execute() and getMappingValue() on this object.
 */

import type { LionDenResolvedConfig, ResolvedNetworkConfig } from "@lionden/config";
import type {
  NetworkManager,
  NetworkConnection,
  DevnodeAccount,
  TransitionCallResult,
  ExecuteOptions,
} from "./types.js";
import { AleoConnection } from "./connection.js";
import { DEVNODE_ACCOUNTS } from "./accounts.js";

export class NetworkManagerImpl implements NetworkManager {
  private readonly config: LionDenResolvedConfig;
  private activeConnection: NetworkConnection | null = null;
  private readonly connections = new Map<string, NetworkConnection>();

  constructor(config: LionDenResolvedConfig) {
    this.config = config;
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

    // Return existing connection if already connected
    const existing = this.connections.get(networkName);
    if (existing) {
      this.activeConnection = existing;
      return existing;
    }

    const connection = this.createConnection(networkName, networkConfig);
    this.connections.set(networkName, connection);
    this.activeConnection = connection;

    return connection;
  }

  getConnection(): NetworkConnection | null {
    return this.activeConnection;
  }

  async disconnectAll(): Promise<void> {
    const conns = [...this.connections.values()];
    this.connections.clear();
    this.activeConnection = null;

    await Promise.all(conns.map((c) => c.close()));
  }

  getAccounts(): DevnodeAccount[] {
    return [...DEVNODE_ACCOUNTS];
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

  async getMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string | null> {
    const conn = this.requireConnection();
    return conn.getMappingValue(programId, mappingName, key);
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

  private createConnection(
    name: string,
    config: ResolvedNetworkConfig,
  ): NetworkConnection {
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
        });
      }
      case "devnet": {
        const endpoint = `http://127.0.0.1:${config.restPort}`;
        return new AleoConnection({
          type: "devnet",
          name,
          endpoint,
          networkId: config.network,
        });
      }
      case "http": {
        return new AleoConnection({
          type: "http",
          name,
          endpoint: config.endpoint,
          networkId: config.network,
          privateKey: config.privateKey,
        });
      }
    }
  }
}
