import { describe, it, expect, vi, beforeEach } from "vitest";
import { NetworkManagerImpl } from "./network-manager.js";
import type { LionDenResolvedConfig } from "@lionden/config";
import type { NetworkConnection } from "./types.js";

const mockConfig: LionDenResolvedConfig = {
  leoVersion: "4.0.0",
  paths: {
    root: "/tmp",
    programs: "/tmp/programs",
    artifacts: "/tmp/artifacts",
    typechain: "/tmp/typechain",
    cache: "/tmp/cache",
  },
  networks: {
    devnode: {
      type: "devnode",
      socketAddr: "127.0.0.1:3030",
      autoBlock: true,
      verbosity: 0,
      accounts: [],
      network: "testnet",
    },
    testnet: {
      type: "http",
      endpoint: "https://api.explorer.provable.com/v1",
      network: "testnet",
    },
  },
  defaultNetwork: "devnode",
  compiler: {
    enableDce: true,
    conditionalBlockMaxDepth: 10,
    buildTests: false,
    extraFlags: [],
  },
  codegen: { enabled: true, outDir: "typechain" },
  testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
  deploy: {
    defaultPriorityFee: 0,
    confirmTransactions: true,
    confirmationTimeout: 60_000,
  },
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
    await expect(manager.connect("nonexistent")).rejects.toThrow(
      'Network "nonexistent" not found',
    );
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
    await expect(
      manager.execute("test.aleo", "foo", []),
    ).rejects.toThrow("No active network connection");
  });

  it("getMappingValue throws when not connected", async () => {
    await expect(
      manager.getMappingValue("test.aleo", "map", "key"),
    ).rejects.toThrow("No active network connection");
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
    const conn = await manager.connect("devnode") as any;
    // The AleoConnection stores privateKey — verify it was set
    expect(conn.privateKey).toBe(
      "APrivateKey1zkp8CZNn3yeCBJ4tRPqpQMBR5Qn3ZjYkBEQR6VcX3v7t7QE",
    );
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
    const conn = await mgr.connect("devnode") as any;
    expect(conn.privateKey).toBe("APrivateKey1zkpCustomKey123");
  });
});
