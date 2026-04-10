import { describe, it, expect } from "vitest";
import { FakeNetworkConnection, FakeNetworkManager } from "./fake-network.js";

describe("FakeNetworkConnection", () => {
  it("returns default balance for unknown addresses", async () => {
    const conn = new FakeNetworkConnection({ initialBalance: 500n });
    expect(await conn.getBalance("aleo1unknown")).toBe(500n);
  });

  it("returns configured balance for known addresses", async () => {
    const conn = new FakeNetworkConnection();
    conn.setBalance("aleo1abc", 42n);
    expect(await conn.getBalance("aleo1abc")).toBe(42n);
  });

  it("returns null for unset mapping values", async () => {
    const conn = new FakeNetworkConnection();
    expect(await conn.getMappingValue("prog.aleo", "balances", "key1")).toBeNull();
  });

  it("returns set mapping values", async () => {
    const conn = new FakeNetworkConnection();
    conn.setMappingValue("prog.aleo", "balances", "key1", "100u64");
    expect(await conn.getMappingValue("prog.aleo", "balances", "key1")).toBe("100u64");
  });

  it("clearMapping removes all entries for that mapping", async () => {
    const conn = new FakeNetworkConnection();
    conn.setMappingValue("prog.aleo", "balances", "k1", "10u64");
    conn.setMappingValue("prog.aleo", "balances", "k2", "20u64");
    conn.clearMapping("prog.aleo", "balances");
    expect(await conn.getMappingValue("prog.aleo", "balances", "k1")).toBeNull();
    expect(await conn.getMappingValue("prog.aleo", "balances", "k2")).toBeNull();
  });

  it("execute returns response by programId + transitionName", async () => {
    const conn = new FakeNetworkConnection();
    conn.setExecuteResponse("token.aleo", "mint", {
      outputs: ["100u64"],
      txId: "at1custom",
    });

    const result = await conn.execute("token.aleo", "mint", ["100u64"]);
    expect(result.outputs).toEqual(["100u64"]);
    expect(result.txId).toBe("at1custom");
  });

  it("execute falls back to default response", async () => {
    const conn = new FakeNetworkConnection();
    conn.setDefaultExecuteResponse({ outputs: ["999u32"] });

    const result = await conn.execute("any.aleo", "anything", []);
    expect(result.outputs).toEqual(["999u32"]);
  });

  it("execute auto-generates txId when response has none", async () => {
    const conn = new FakeNetworkConnection();
    const r1 = await conn.execute("p.aleo", "t", []);
    const r2 = await conn.execute("p.aleo", "t", []);
    expect(r1.txId).toBe("at1fake0");
    expect(r2.txId).toBe("at1fake1");
  });

  it("execute increments block height", async () => {
    const conn = new FakeNetworkConnection({ initialBlockHeight: 10 });
    await conn.execute("p.aleo", "t", []);
    expect(await conn.getBlockHeight()).toBe(11);
  });

  it("broadcastTransaction returns auto-incrementing txIds", async () => {
    const conn = new FakeNetworkConnection();
    const tx1 = await conn.broadcastTransaction("bytes1");
    const tx2 = await conn.broadcastTransaction("bytes2");
    expect(tx1).toBe("at1fake0");
    expect(tx2).toBe("at1fake1");
  });

  it("broadcastTransaction increments block height", async () => {
    const conn = new FakeNetworkConnection({ initialBlockHeight: 5 });
    await conn.broadcastTransaction("bytes");
    expect(await conn.getBlockHeight()).toBe(6);
  });

  it("waitForConfirmation returns accepted by default", async () => {
    const conn = new FakeNetworkConnection();
    const result = await conn.waitForConfirmation("at1tx");
    expect(result.status).toBe("accepted");
    expect(result.txId).toBe("at1tx");
  });

  it("waitForConfirmation returns rejected when configured", async () => {
    const conn = new FakeNetworkConnection();
    conn.setConfirmBehavior("reject");
    const result = await conn.waitForConfirmation("at1tx");
    expect(result.status).toBe("rejected");
  });

  it("advanceBlocks increments block height", async () => {
    const conn = new FakeNetworkConnection({ initialBlockHeight: 1 });
    await conn.advanceBlocks(5);
    expect(await conn.getBlockHeight()).toBe(6);
  });

  it("setBlockHeight overrides current height", async () => {
    const conn = new FakeNetworkConnection();
    conn.setBlockHeight(100);
    expect(await conn.getBlockHeight()).toBe(100);
  });

  // Call recording
  it("records all method calls", async () => {
    const conn = new FakeNetworkConnection();
    await conn.getBalance();
    await conn.getMappingValue("p", "m", "k");
    await conn.execute("p", "t", []);

    expect(conn.calls).toHaveLength(3);
    expect(conn.calls[0]!.method).toBe("getBalance");
    expect(conn.calls[1]!.method).toBe("getMappingValue");
    expect(conn.calls[2]!.method).toBe("execute");
  });

  it("getCallsTo filters by method name", async () => {
    const conn = new FakeNetworkConnection();
    await conn.getBalance();
    await conn.execute("p", "t", []);
    await conn.getBalance("aleo1x");

    const balanceCalls = conn.getCallsTo("getBalance");
    expect(balanceCalls).toHaveLength(2);
    expect(balanceCalls[0]!.args).toEqual([undefined]);
    expect(balanceCalls[1]!.args).toEqual(["aleo1x"]);
  });

  it("resetCalls clears recorded calls", async () => {
    const conn = new FakeNetworkConnection();
    await conn.getBalance();
    expect(conn.calls).toHaveLength(1);
    conn.resetCalls();
    expect(conn.calls).toHaveLength(0);
  });

  it("calls include timestamps", async () => {
    const before = Date.now();
    const conn = new FakeNetworkConnection();
    await conn.getBalance();
    const after = Date.now();

    expect(conn.calls[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(conn.calls[0]!.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("FakeNetworkManager", () => {
  it("connect returns the fake connection", async () => {
    const conn = new FakeNetworkConnection();
    const manager = new FakeNetworkManager({ connection: conn });

    const result = await manager.connect();
    expect(result).toBe(conn);
  });

  it("connect throws for unknown network names", async () => {
    const manager = new FakeNetworkManager({ knownNetworks: ["devnode"] });
    await expect(manager.connect("testnet")).rejects.toThrow(
      /Network "testnet" not found/,
    );
  });

  it("connect accepts known network names", async () => {
    const manager = new FakeNetworkManager({
      knownNetworks: ["devnode", "testnet"],
    });
    await expect(manager.connect("testnet")).resolves.toBeDefined();
  });

  it("getConnection returns null before connect", () => {
    const manager = new FakeNetworkManager();
    expect(manager.getConnection()).toBeNull();
  });

  it("getConnection returns connection after connect", async () => {
    const manager = new FakeNetworkManager();
    await manager.connect();
    expect(manager.getConnection()).toBe(manager.connection);
  });

  it("execute throws before connect", async () => {
    const manager = new FakeNetworkManager();
    await expect(manager.execute("p.aleo", "fn", [])).rejects.toThrow(
      /No active network connection/,
    );
  });

  it("getMappingValue throws before connect", async () => {
    const manager = new FakeNetworkManager();
    await expect(manager.getMappingValue("p.aleo", "m", "k")).rejects.toThrow(
      /No active network connection/,
    );
  });

  it("disconnectAll clears the active connection and calls close", async () => {
    const manager = new FakeNetworkManager();
    await manager.connect();
    await manager.disconnectAll();
    expect(manager.getConnection()).toBeNull();
    expect(manager.connection.getCallsTo("close")).toHaveLength(1);
  });

  it("getAccounts returns DEVNODE_ACCOUNTS by default", () => {
    const manager = new FakeNetworkManager();
    const accounts = manager.getAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts[0]!.privateKey).toBeDefined();
  });

  it("execute delegates to connection after connect", async () => {
    const conn = new FakeNetworkConnection();
    conn.setDefaultExecuteResponse({ outputs: ["42u32"] });
    const manager = new FakeNetworkManager({ connection: conn });
    await manager.connect();

    const result = await manager.execute("p.aleo", "fn", []);
    expect(result.outputs).toEqual(["42u32"]);
    expect(conn.getCallsTo("execute")).toHaveLength(1);
  });

  it("getMappingValue delegates to connection after connect", async () => {
    const conn = new FakeNetworkConnection();
    conn.setMappingValue("p.aleo", "m", "k", "val");
    const manager = new FakeNetworkManager({ connection: conn });
    await manager.connect();

    const result = await manager.getMappingValue("p.aleo", "m", "k");
    expect(result).toBe("val");
  });
});
