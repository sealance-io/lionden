import type { LionDenResolvedConfig, ResolvedNamedAccountsConfig } from "@lionden/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNODE_ACCOUNTS } from "./accounts.js";
import { NetworkManagerImpl } from "./network-manager.js";
import type { NetworkConnection } from "./types.js";

const mockConfig: LionDenResolvedConfig = {
  leoVersion: "4.0.0",
  skipLeoVersionCheck: false,
  leoBinary: "leo",
  paths: {
    root: "/tmp",
    programs: "/tmp/programs",
    artifacts: "/tmp/artifacts",
    typechain: "/tmp/typechain",
    cache: "/tmp/cache",
    deployments: "/tmp/deployments",
  },
  networks: {
    devnode: {
      type: "devnode",
      socketAddr: "127.0.0.1:3030",
      autoBlock: true,
      verbosity: 0,
      accounts: [],
      network: "testnet",
      ephemeral: true,
    },
    testnet: {
      type: "http",
      endpoint: "https://api.explorer.provable.com/v1",
      network: "testnet",
      ephemeral: false,
    },
  },
  defaultNetwork: "devnode",
  compiler: {
    enableDce: true,
    conditionalBlockMaxDepth: 10,
    buildTests: false,
    extraFlags: [],
  },
  codegen: { enabled: true, outDir: "typechain", dynamicRecords: {} },
  testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
  deploy: {
    defaultPriorityFee: 0,
    privateFee: false,
    confirmTransactions: true,
    confirmationTimeout: 60_000,
    deploymentsDir: "deployments",
    skipDeployed: true,
    autoExport: false,
  },
  sdk: { keyCache: { storage: "memory" } },
  execution: { imports: {} },
  namedAccounts: {},
};

describe("NetworkManagerImpl", () => {
  let manager: NetworkManagerImpl;

  beforeEach(() => {
    manager = new NetworkManagerImpl(mockConfig);
  });

  it("getConnection returns null initially", () => {
    expect(manager.getConnection()).toBeNull();
  });

  it("connect creates a devnode connection", async () => {
    const conn = await manager.connect("devnode");

    expect(conn.type).toBe("devnode");
    expect(conn.name).toBe("devnode");
    expect(conn.endpoint).toBe("http://127.0.0.1:3030");
    expect(conn.networkId).toBe("testnet");
  });

  it("connect creates an HTTP connection", async () => {
    const conn = await manager.connect("testnet");

    expect(conn.type).toBe("http");
    expect(conn.name).toBe("testnet");
    expect(conn.endpoint).toBe("https://api.explorer.provable.com/v1");
    expect(conn.networkId).toBe("testnet");
  });

  it("connect uses default network when no name specified", async () => {
    const conn = await manager.connect();

    expect(conn.name).toBe("devnode");
  });

  it("connect throws for unknown network", async () => {
    await expect(manager.connect("nonexistent")).rejects.toThrow('Network "nonexistent" not found');
  });

  it("connect reuses existing connection", async () => {
    const conn1 = await manager.connect("devnode");
    const conn2 = await manager.connect("devnode");

    expect(conn1).toBe(conn2);
  });

  it("getConnection returns active connection after connect", async () => {
    await manager.connect("devnode");
    const conn = manager.getConnection();

    expect(conn).not.toBeNull();
    expect(conn!.name).toBe("devnode");
  });

  it("disconnectAll clears all connections", async () => {
    await manager.connect("devnode");
    await manager.connect("testnet");

    await manager.disconnectAll();

    expect(manager.getConnection()).toBeNull();
  });

  it("getAccounts returns 4 devnode accounts", () => {
    const accounts = manager.getAccounts();

    expect(accounts).toHaveLength(4);
    expect(accounts[0]!.name).toBe("account-0");
  });

  it("execute throws when not connected", async () => {
    await expect(manager.execute("test.aleo", "foo", [])).rejects.toThrow(
      "No active network connection",
    );
  });

  it("checkLocalExecution throws when not connected", async () => {
    await expect(manager.checkLocalExecution("test.aleo", "foo", [])).rejects.toThrow(
      "No active network connection",
    );
  });

  it("checkLocalExecution delegates to the active connection", async () => {
    const conn = (await manager.connect("devnode")) as NetworkConnection & {
      checkLocalExecution?: ReturnType<typeof vi.fn>;
    };
    const checkLocalExecution = vi.fn().mockResolvedValue(undefined);
    conn.checkLocalExecution = checkLocalExecution;

    await manager.checkLocalExecution("test.aleo", "foo", ["1u32"], {
      mode: "local",
    });

    expect(checkLocalExecution).toHaveBeenCalledWith("test.aleo", "foo", ["1u32"], {
      mode: "local",
    });
  });

  it("getMappingValue throws when not connected", async () => {
    await expect(manager.getMappingValue("test.aleo", "map", "key")).rejects.toThrow(
      "No active network connection",
    );
  });

  it("devnode connection has advanceBlocks method", async () => {
    const conn = await manager.connect("devnode");
    expect(conn.advanceBlocks).toBeDefined();
    expect(typeof conn.advanceBlocks).toBe("function");
  });

  it("http connection does not have advanceBlocks method", async () => {
    const conn = await manager.connect("testnet");
    expect(conn.advanceBlocks).toBeUndefined();
  });

  it("devnode connection falls back to well-known account-0 when no accounts configured", async () => {
    // mockConfig has accounts: [] for devnode
    const conn = (await manager.connect("devnode")) as any;
    // The AleoConnection stores privateKey — verify it was set
    expect(conn.privateKey).toBe("APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH");
  });

  it("threads projectRoot and executionImports into devnode and http connections", async () => {
    const importsConfig = {
      ...mockConfig,
      execution: {
        imports: {
          "governance.aleo": [{ kind: "programId" as const, programId: "voting_power.aleo" }],
        },
      },
    };
    const mgr = new NetworkManagerImpl(importsConfig);

    const devnodeConn = (await mgr.connect("devnode")) as any;
    expect(devnodeConn.projectRoot).toBe(mockConfig.paths.root);
    expect(devnodeConn.executionImports).toEqual(importsConfig.execution.imports);

    const httpConn = (await mgr.connect("testnet")) as any;
    expect(httpConn.projectRoot).toBe(mockConfig.paths.root);
    expect(httpConn.executionImports).toEqual(importsConfig.execution.imports);
  });

  it("connect creates a fresh connection when cached one is closed", async () => {
    const conn1 = await manager.connect("devnode");
    await conn1.close();

    const conn2 = await manager.connect("devnode");

    expect(conn2).not.toBe(conn1);
    expect(conn2.closed).toBe(false);
    expect(conn2.type).toBe("devnode");
  });

  it("devnode connection uses configured account when provided", async () => {
    const configWithAccount = {
      ...mockConfig,
      networks: {
        ...mockConfig.networks,
        devnode: {
          ...mockConfig.networks["devnode"]!,
          accounts: [{ privateKey: "APrivateKey1zkpCustomKey123" }],
        },
      },
    };
    const mgr = new NetworkManagerImpl(configWithAccount as LionDenResolvedConfig);
    const conn = (await mgr.connect("devnode")) as any;
    expect(conn.privateKey).toBe("APrivateKey1zkpCustomKey123");
  });
});

// ---------------------------------------------------------------------------
// Egress policy resolution
// ---------------------------------------------------------------------------

describe("NetworkManagerImpl — egress policy defaults", () => {
  it("devnode connections scope allowedNetworkHosts to the devnode socket and default to block on violation", async () => {
    const mgr = new NetworkManagerImpl(mockConfig);
    const conn = await mgr.connect("devnode");
    expect(conn.egressPolicy.violation).toBe("block");
    expect([...conn.egressPolicy.allowedNetworkHosts]).toEqual(["127.0.0.1:3030"]);
  });

  it("http connections scope allowedNetworkHosts to the configured endpoint", async () => {
    const mgr = new NetworkManagerImpl(mockConfig);
    const conn = await mgr.connect("testnet");
    expect(conn.egressPolicy.violation).toBe("block");
    expect([...conn.egressPolicy.allowedNetworkHosts]).toEqual(["api.explorer.provable.com"]);
  });

  it("sdk.egress.networkHosts override EXTENDS the per-connection network host list", async () => {
    const config: LionDenResolvedConfig = {
      ...mockConfig,
      sdk: {
        keyCache: { storage: "memory" },
        egress: { networkHosts: ["telemetry.example"] },
      },
    };
    const mgr = new NetworkManagerImpl(config);
    const devConn = await mgr.connect("devnode");
    expect(new Set(devConn.egressPolicy.allowedNetworkHosts)).toEqual(
      new Set(["127.0.0.1:3030", "telemetry.example"]),
    );
  });

  it("sdk.egress.violation override propagates to the resolved policy", async () => {
    const config: LionDenResolvedConfig = {
      ...mockConfig,
      sdk: {
        keyCache: { storage: "memory" },
        egress: { violation: "warn" },
      },
    };
    const mgr = new NetworkManagerImpl(config);
    const conn = await mgr.connect("devnode");
    expect(conn.egressPolicy.violation).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Named account lifecycle integration tests
// ---------------------------------------------------------------------------

describe("NetworkManagerImpl — named account lifecycle", () => {
  const DEPLOYER_ADDR_0 = DEVNODE_ACCOUNTS[0]!.address;
  const DEPLOYER_KEY_0 = DEVNODE_ACCOUNTS[0]!.privateKey;
  const DEPLOYER_ADDR_1 = DEVNODE_ACCOUNTS[1]!.address;

  // Two devnode networks; deployer uses index 0 by default, index 1 for netB.
  const namedAccountsConfig = {
    ...mockConfig,
    networks: {
      netA: {
        type: "devnode" as const,
        socketAddr: "127.0.0.1:3030",
        autoBlock: true,
        verbosity: 0,
        accounts: [],
        network: "testnet" as const,
        ephemeral: true,
      },
      netB: {
        type: "devnode" as const,
        socketAddr: "127.0.0.1:3031",
        autoBlock: true,
        verbosity: 0,
        accounts: [],
        network: "testnet" as const,
        ephemeral: true,
      },
    },
    defaultNetwork: "netA",
    namedAccounts: {
      deployer: {
        networks: { netB: { type: "index" as const, index: 1 } },
        default: { type: "index" as const, index: 0 },
      },
    } satisfies ResolvedNamedAccountsConfig,
  } as LionDenResolvedConfig;

  it("getNamedAccounts returns {} before any connect", () => {
    const mgr = new NetworkManagerImpl(namedAccountsConfig);
    expect(mgr.getNamedAccounts()).toEqual({});
  });

  it("getNamedAccounts returns resolved accounts after connect", async () => {
    const mgr = new NetworkManagerImpl(namedAccountsConfig);
    await mgr.connect("netA");
    expect(mgr.getNamedAccounts()["deployer"]).toEqual({
      type: "signable",
      name: "deployer",
      address: DEPLOYER_ADDR_0,
      privateKey: DEPLOYER_KEY_0,
    });
  });

  it("switching networks restores correct cached named accounts", async () => {
    const mgr = new NetworkManagerImpl(namedAccountsConfig);

    await mgr.connect("netA");
    expect(mgr.getNamedAccounts()["deployer"]!.address).toBe(DEPLOYER_ADDR_0);

    await mgr.connect("netB");
    expect(mgr.getNamedAccounts()["deployer"]!.address).toBe(DEPLOYER_ADDR_1);

    // Switching back restores from cache — does not re-resolve
    await mgr.connect("netA");
    expect(mgr.getNamedAccounts()["deployer"]!.address).toBe(DEPLOYER_ADDR_0);
  });

  it("failed named-account resolution preserves previous active connection and accounts", async () => {
    // HTTP network with an index-based deployer → throws when resolving
    const failConfig = {
      ...mockConfig,
      networks: {
        devnode: mockConfig.networks["devnode"]!,
        testnet: {
          type: "http" as const,
          endpoint: "https://api.explorer.provable.com/v1",
          network: "testnet" as const,
          ephemeral: false,
        },
      },
      namedAccounts: {
        deployer: {
          networks: {},
          default: { type: "index" as const, index: 0 }, // index on HTTP → throws
        },
      } satisfies ResolvedNamedAccountsConfig,
    } as LionDenResolvedConfig;

    const mgr = new NetworkManagerImpl(failConfig);

    const conn1 = await mgr.connect("devnode");
    expect(mgr.getNamedAccounts()["deployer"]!.address).toBe(DEPLOYER_ADDR_0);

    await expect(mgr.connect("testnet")).rejects.toThrow(/HTTP/i);

    // Previous active connection preserved
    expect(mgr.getConnection()).toBe(conn1);
    // Previous named accounts preserved
    expect(mgr.getNamedAccounts()["deployer"]!.address).toBe(DEPLOYER_ADDR_0);
  });

  it("disconnectAll clears named accounts", async () => {
    const mgr = new NetworkManagerImpl(namedAccountsConfig);
    await mgr.connect("netA");
    expect(Object.keys(mgr.getNamedAccounts())).toHaveLength(1);

    await mgr.disconnectAll();
    expect(mgr.getNamedAccounts()).toEqual({});
  });

  it("getNamedAccounts returns a defensive copy — mutations do not affect internal state", async () => {
    const mgr = new NetworkManagerImpl(namedAccountsConfig);
    await mgr.connect("netA");

    const copy = mgr.getNamedAccounts() as Record<string, unknown>;
    delete copy["deployer"];

    // Internal state unaffected
    expect(mgr.getNamedAccounts()["deployer"]).toBeDefined();
  });
});
