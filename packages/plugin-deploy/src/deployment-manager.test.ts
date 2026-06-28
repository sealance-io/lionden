import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactStore } from "@lionden/core";
import type { ProgramABI } from "@lionden/leo-compiler";
import type { NetworkManager } from "@lionden/network";
import { createMockConfig, createMockConnection } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentManagerImpl } from "./deployment-manager.js";
import {
  readAbiSnapshot,
  readDeploymentRecord,
  readHistory,
  readNetworkMetadata,
  readPendingMarker,
  writeAbiSnapshot,
  writeDeploymentRecord,
} from "./deployment-state.js";
import type {
  CompleteDeploymentRecord,
  DegradedDeploymentRecord,
  PendingDeployment,
  RecoveredDeploymentRecord,
} from "./deployment-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-mgr-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const mockAbi: ProgramABI = {
  program: "hello.aleo",
  structs: [],
  records: [],
  mappings: [],
  storage_variables: [],
  transitions: [],
};

function compiledSource(programId = "hello.aleo", edition = 1): string {
  return `program ${programId};\nconstructor:\n    assert.eq edition ${edition}u16;\n`;
}

function makeConfig(opts: { networkType?: "devnode" | "http"; ephemeral?: boolean } = {}) {
  const { networkType = "devnode", ephemeral } = opts;
  if (networkType === "devnode") {
    const config = createMockConfig({ root: tmpDir });
    if (ephemeral !== undefined) {
      (config.networks["devnode"] as any).ephemeral = ephemeral;
    }
    return config;
  }
  return createMockConfig({
    root: tmpDir,
    networks: {
      testnet: {
        type: "http",
        socketAddr: undefined,
        autoBlock: false,
        verbosity: 0,
        accounts: [],
        network: "testnet",
      } as any, // override with HTTP shape below
    },
    defaultNetwork: "testnet",
  });
}

function makeHttpConfig() {
  return createMockConfig({
    root: tmpDir,
    networks: {
      testnet: {
        type: "http",
        endpoint: "https://api.example.com",
        network: "testnet",
      } as any,
    },
    defaultNetwork: "testnet",
  });
}

function makeArtifactStore(): ArtifactStore {
  return {
    getAbi: vi.fn().mockReturnValue(undefined),
    getAleoSource: vi.fn().mockReturnValue(undefined),
    getProgramIds: vi.fn().mockReturnValue([]),
    setAbi: vi.fn(),
    setAleoSource: vi.fn(),
  };
}

function makeNetworkManager(connection = createMockConnection()): NetworkManager {
  return {
    connect: vi.fn().mockResolvedValue(connection),
    getConnection: vi.fn().mockReturnValue(connection),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
    getAccounts: vi.fn().mockReturnValue([]),
    getNamedAccounts: vi.fn().mockReturnValue({}),
    execute: vi.fn(),
    getMappingValue: vi.fn(),
    getStorageValue: vi.fn(),
    getStorageVectorLength: vi.fn().mockResolvedValue(0),
    getStorageVectorValue: vi.fn().mockResolvedValue(null),
    waitForConfirmation: vi.fn(),
    getTransitionOutputs: vi.fn(),
  };
}

function makeDisconnectedNetworkManager(): NetworkManager {
  return {
    connect: vi.fn(),
    getConnection: vi.fn().mockReturnValue(null),
    disconnectAll: vi.fn(),
    getAccounts: vi.fn().mockReturnValue([]),
    getNamedAccounts: vi.fn().mockReturnValue({}),
    execute: vi.fn(),
    getMappingValue: vi.fn(),
    getStorageValue: vi.fn(),
    getStorageVectorLength: vi.fn().mockResolvedValue(0),
    getStorageVectorValue: vi.fn().mockResolvedValue(null),
    waitForConfirmation: vi.fn(),
    getTransitionOutputs: vi.fn(),
  };
}

function makeManager(
  opts: {
    networkType?: "devnode" | "http";
    ephemeral?: boolean;
    connection?: ReturnType<typeof createMockConnection>;
    networkManager?: NetworkManager;
    artifacts?: ArtifactStore;
  } = {},
) {
  const config =
    opts.networkType === "http" ? makeHttpConfig() : makeConfig({ ephemeral: opts.ephemeral });
  const conn = opts.connection ?? createMockConnection();
  const manager = opts.networkManager ?? makeNetworkManager(conn);
  const artifacts = opts.artifacts ?? makeArtifactStore();
  return {
    dm: new DeploymentManagerImpl(config, () => manager, artifacts),
    connection: conn,
    networkManager: manager,
    config,
  };
}

const completeRecord: CompleteDeploymentRecord = {
  status: "complete",
  programId: "hello.aleo",
  edition: 1,
  constructor: { type: "noupgrade" },
  abiHash: "abc123",
  network: "devnode",
  endpoint: "http://127.0.0.1:3030",
  updatedAt: "2026-01-01T00:00:00.000Z",
  historyCount: 1,
  txId: "at1abc",
  blockHeight: 42,
  deployerAddress: "aleo1abc",
  deployedAt: "2026-01-01T00:00:00.000Z",
};

const secondCompleteRecord: CompleteDeploymentRecord = {
  ...completeRecord,
  programId: "goodbye.aleo",
  abiHash: "def456",
  txId: "at1def",
  blockHeight: 43,
};

// ---------------------------------------------------------------------------
// Devnode session policy
// ---------------------------------------------------------------------------

describe("devnode: getDeployment validates on-chain", () => {
  it("returns null when program not on-chain, even if disk state exists", async () => {
    const { dm, config } = makeManager();
    // Write disk state
    writeDeploymentRecord(config.paths.deployments, "devnode", completeRecord);

    // Connection says program not on-chain
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const manager = makeNetworkManager(conn);
    const dm2 = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    const result = await dm2.getDeployment("hello.aleo");
    expect(result).toBeNull();
  });

  it("returns cached record when program is on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(compiledSource()),
    });
    const { dm, config } = makeManager({ connection: conn });
    // Write disk state
    writeDeploymentRecord(config.paths.deployments, "devnode", completeRecord);

    const result = await dm.getDeployment("hello.aleo");
    expect(result).not.toBeNull();
    expect(result!.programId).toBe("hello.aleo");
  });

  it("creates degraded record when on-chain but no prior state", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(compiledSource("hello.aleo", 2)),
    });
    const { dm } = makeManager({ connection: conn });

    const result = await dm.getDeployment("hello.aleo");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("degraded");
    expect(result!.edition).toBe(2);
  });

  it("returns cache-only when no connection available", async () => {
    const { dm } = makeManager();
    // networkManager.getConnection() returns null
    const managerWithNull = makeDisconnectedNetworkManager();
    const dm2 = new DeploymentManagerImpl(makeConfig(), () => managerWithNull, makeArtifactStore());

    // Nothing in cache
    const result = await dm2.getDeployment("hello.aleo");
    expect(result).toBeNull();
  });

  it("getAllDeployments validates cache before non-ephemeral disk records for devnode", async () => {
    const getProgramSource = vi.fn(async (programId: string) =>
      compiledSource(programId, programId === "hello.aleo" ? 1 : 2),
    );
    const conn = createMockConnection({ getProgramSource });
    const config = makeConfig({ ephemeral: false });
    const manager = makeNetworkManager(conn);
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    await dm.record(completeRecord, "deploy", { abi: mockAbi });
    writeDeploymentRecord(config.paths.deployments, "devnode", secondCompleteRecord);

    const records = await dm.getAllDeployments();
    expect(records.map((record) => record.programId)).toEqual(["hello.aleo", "goodbye.aleo"]);
    expect(getProgramSource.mock.calls.map(([programId]) => programId)).toEqual([
      "hello.aleo",
      "goodbye.aleo",
    ]);
  });

  it("getAllDeployments returns cache-only when no devnode connection is available", async () => {
    const config = makeConfig();
    const manager = makeDisconnectedNetworkManager();
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    await dm.record(completeRecord, "deploy", { abi: mockAbi });
    writeDeploymentRecord(config.paths.deployments, "devnode", secondCompleteRecord);

    const records = await dm.getAllDeployments();
    expect(records.map((record) => record.programId)).toEqual(["hello.aleo"]);
  });

  it("filters cached devnode records missing on-chain and clears cache", async () => {
    const getProgramSource = vi.fn().mockResolvedValue(null);
    const conn = createMockConnection({ getProgramSource });
    const config = makeConfig({ ephemeral: false });
    const manager = makeNetworkManager(conn);
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    await dm.record(completeRecord, "deploy", { abi: mockAbi });

    const records = await dm.getAllDeployments();
    expect(records).toHaveLength(0);
    expect(dm.getCached("hello.aleo")).toBeNull();
    expect(readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo")).not.toBeNull();
  });

  it("filters non-ephemeral devnode disk records missing on-chain without deleting disk", async () => {
    const getProgramSource = vi.fn().mockResolvedValue(null);
    const conn = createMockConnection({ getProgramSource });
    const config = makeConfig({ ephemeral: false });
    const manager = makeNetworkManager(conn);
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    writeDeploymentRecord(config.paths.deployments, "devnode", completeRecord);

    const records = await dm.getAllDeployments();
    expect(records).toHaveLength(0);
    expect(dm.getCached("hello.aleo")).toBeNull();
    expect(readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo")).not.toBeNull();
  });

  it("export returns validated programs for devnode", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(compiledSource()),
    });
    const config = makeConfig();
    const manager = makeNetworkManager(conn);
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    await dm.record(completeRecord, "deploy", { abi: mockAbi });
    const bundle = await dm.export("devnode");

    expect(Object.keys(bundle.programs)).toHaveLength(1);
    expect(bundle.programs["hello.aleo"]).toBeDefined();
  });

  it("export omits stale cached devnode records", async () => {
    const conn = createMockConnection({ getProgramSource: vi.fn().mockResolvedValue(null) });
    const config = makeConfig();
    const manager = makeNetworkManager(conn);
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    await dm.record(completeRecord, "deploy", { abi: mockAbi });
    const bundle = await dm.export("devnode");

    expect(bundle.programs).toEqual({});
    expect(dm.getCached("hello.aleo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP network metadata validation
// ---------------------------------------------------------------------------

describe("HTTP: metadata validation", () => {
  it("trusts disk state after metadata validation", async () => {
    const config = makeHttpConfig();
    const conn = createMockConnection({ type: "http" as const });
    const manager = makeNetworkManager(conn);
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    // Write valid metadata
    writeDeploymentRecord(config.paths.deployments, "testnet", {
      ...completeRecord,
      network: "testnet",
      endpoint: "https://api.example.com",
    });

    // Write network metadata matching config
    const { writeNetworkMetadata } = await import("./deployment-state.js");
    writeNetworkMetadata(config.paths.deployments, "testnet", {
      type: "http",
      networkId: "testnet",
      endpoint: "https://api.example.com",
    });

    const result = await dm.getDeployment("hello.aleo", "testnet");
    expect(result).not.toBeNull();
  });

  it("throws when metadata mismatches config", async () => {
    const config = makeHttpConfig();
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());

    const { writeNetworkMetadata } = await import("./deployment-state.js");
    writeNetworkMetadata(config.paths.deployments, "testnet", {
      type: "http",
      networkId: "testnet",
      endpoint: "https://DIFFERENT-endpoint.com", // mismatch
    });

    await expect(dm.getDeployment("hello.aleo", "testnet")).rejects.toThrow(
      "Network metadata mismatch",
    );
  });

  it("throws when records exist but metadata is missing", async () => {
    const config = makeHttpConfig();
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());

    // Write record without metadata
    writeDeploymentRecord(config.paths.deployments, "testnet", {
      ...completeRecord,
      network: "testnet",
      endpoint: "https://api.example.com",
    });

    await expect(dm.getDeployment("hello.aleo", "testnet")).rejects.toThrow(
      "Deployment records exist",
    );
  });

  it("returns null when no metadata and no records (empty state)", async () => {
    const config = makeHttpConfig();
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());

    const result = await dm.getDeployment("hello.aleo", "testnet");
    expect(result).toBeNull();
  });

  it("writes network metadata on first record()", async () => {
    const config = makeHttpConfig();
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());

    await dm.record(
      { ...completeRecord, network: "testnet", endpoint: "https://api.example.com" },
      "deploy",
      { abi: mockAbi },
    );

    const meta = readNetworkMetadata(config.paths.deployments, "testnet");
    expect(meta).not.toBeNull();
    expect(meta!.endpoint).toBe("https://api.example.com");
    expect(meta!.networkId).toBe("testnet");
  });
});

// ---------------------------------------------------------------------------
// record() behavior
// ---------------------------------------------------------------------------

describe("record()", () => {
  it("persists record, writes ABI snapshot, updates cache, clears pending marker", async () => {
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());

    // Write a pending marker first
    const pending: PendingDeployment = {
      programId: "hello.aleo",
      action: "deploy",
      startedAt: "2026-01-01T00:00:00.000Z",
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: null,
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    };
    await dm.setPending(pending);

    // Record a deployment
    await dm.record(completeRecord, "deploy", { abi: mockAbi });

    // ABI snapshot written
    const abi = readAbiSnapshot(config.paths.deployments, "devnode", "hello.aleo");
    expect(abi).not.toBeNull();

    // Pending marker cleared
    const marker = readPendingMarker(config.paths.deployments, "devnode", "hello.aleo");
    expect(marker).toBeNull();

    // Cache updated
    expect(dm.getCached("hello.aleo")).not.toBeNull();
  });

  it("does not downgrade a complete on-disk record to degraded when edition matches (fresh-process cache miss guard)", async () => {
    // Simulate devnode fresh-process restart: disk has a complete record but
    // the in-memory cache is cold (new DeploymentManagerImpl instance).
    // Uses ephemeral: false so disk reads/writes are exercised.
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());
    // Write complete record directly to disk (as if a previous process did it)
    writeDeploymentRecord(config.paths.deployments, "devnode", completeRecord);

    // Now call record() with a degraded record at the same edition — must NOT overwrite
    const degraded: DegradedDeploymentRecord = {
      status: "degraded",
      programId: "hello.aleo",
      edition: 1, // same as completeRecord.edition
      constructor: { type: null },
      abiHash: null,
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      updatedAt: new Date().toISOString(),
      historyCount: 0,
      txId: null,
      blockHeight: null,
      deployerAddress: null,
      deployedAt: null,
      feePaid: null,
    };
    await dm.record(degraded, "deploy");

    // Cache should hold the complete record (loaded from disk), not the degraded one
    const cached = dm.getCached("hello.aleo");
    expect(cached?.status).toBe("complete");
    expect(cached?.txId).toBe("at1abc");

    // Disk should still have the complete record
    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("complete");

    // No history entry should have been appended — the early return skips appendHistory()
    const history = readHistory(config.paths.deployments, "devnode", "hello.aleo");
    expect(history).toHaveLength(0);
  });

  it("does not downgrade a recovered on-disk record to degraded when edition matches", async () => {
    // Same invariant as complete: a recovered record at the same edition/endpoint must
    // survive a degraded write from a fresh-process cache miss.
    const recovered: RecoveredDeploymentRecord = {
      status: "recovered",
      programId: "hello.aleo",
      edition: 1,
      constructor: { type: "noupgrade" },
      abiHash: "abc123",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      updatedAt: "2026-01-01T00:00:00.000Z",
      historyCount: 1,
      txId: null,
      blockHeight: null,
      deployerAddress: "aleo1abc",
      deployedAt: "2026-01-01T00:00:00.000Z",
      feePaid: null,
    };
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());
    writeDeploymentRecord(config.paths.deployments, "devnode", recovered);

    const degraded: DegradedDeploymentRecord = {
      status: "degraded",
      programId: "hello.aleo",
      edition: 1,
      constructor: { type: null },
      abiHash: null,
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      updatedAt: new Date().toISOString(),
      historyCount: 0,
      txId: null,
      blockHeight: null,
      deployerAddress: null,
      deployedAt: null,
      feePaid: null,
    };
    await dm.record(degraded, "deploy");

    const cached = dm.getCached("hello.aleo");
    expect(cached?.status).toBe("recovered");

    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("recovered");

    // No history entry appended
    const history = readHistory(config.paths.deployments, "devnode", "hello.aleo");
    expect(history).toHaveLength(0);
  });

  it("writes degraded record and deletes ABI snapshot when edition differs from on-disk complete (out-of-band upgrade guard)", async () => {
    // Disk has a complete record at edition 1 with an ABI snapshot, but on-chain the
    // program is now at edition 2 (upgraded outside LionDen). The degraded record carries
    // the observed edition 2 and must overwrite the stale disk state. The old ABI snapshot
    // must also be deleted so upgradeAction() cannot validate against the prior edition's ABI.
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());
    writeDeploymentRecord(config.paths.deployments, "devnode", completeRecord); // edition: 1
    // Seed the ABI snapshot as a prior complete deploy would have written it
    writeAbiSnapshot(config.paths.deployments, "devnode", "hello.aleo", mockAbi);
    expect(readAbiSnapshot(config.paths.deployments, "devnode", "hello.aleo")).not.toBeNull();

    const degradedEdition2: DegradedDeploymentRecord = {
      status: "degraded",
      programId: "hello.aleo",
      edition: 2, // differs from disk edition 1
      constructor: { type: null },
      abiHash: null,
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      updatedAt: new Date().toISOString(),
      historyCount: 0,
      txId: null,
      blockHeight: null,
      deployerAddress: null,
      deployedAt: null,
      feePaid: null,
    };
    await dm.record(degradedEdition2, "deploy");

    // The degraded record at edition 2 should have been written
    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("degraded");
    expect(onDisk?.edition).toBe(2);

    // A history entry must exist for the write
    const history = readHistory(config.paths.deployments, "devnode", "hello.aleo");
    expect(history).toHaveLength(1);

    // The ABI snapshot must be deleted — stale prior-edition ABI must not be usable by upgradeAction()
    expect(readAbiSnapshot(config.paths.deployments, "devnode", "hello.aleo")).toBeNull();
  });

  it("clears in-memory ABI cache when a complete record is downgraded to degraded", async () => {
    // Regression: disk snapshot is deleted on degraded write, but the in-memory abiCache
    // must also be cleared so getCachedAbi() cannot return a stale ABI that the degraded
    // record no longer trusts (same invariant as the disk deletion, applied to memory).
    const { dm } = makeManager({ ephemeral: true }); // ephemeral so we verify memory-only path

    // 1. Record complete deployment — populates abiCache
    await dm.record(completeRecord, "deploy", { abi: mockAbi });
    expect(dm.getCachedAbi("hello.aleo", "devnode")).not.toBeNull();

    // 2. Downgrade to degraded (different edition so guard does not short-circuit)
    const degraded: DegradedDeploymentRecord = {
      status: "degraded",
      programId: "hello.aleo",
      edition: 2, // differs from completeRecord.edition (1) — bypasses degraded guard
      constructor: { type: null },
      abiHash: null,
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      updatedAt: new Date().toISOString(),
      historyCount: 0,
      txId: null,
      blockHeight: null,
      deployerAddress: null,
      deployedAt: null,
      feePaid: null,
    };
    await dm.record(degraded, "deploy");

    // 3. ABI cache must be cleared — stale ABI must not be accessible
    expect(dm.getCachedAbi("hello.aleo", "devnode")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isDeployed / isCachedDeployed
// ---------------------------------------------------------------------------

describe("isDeployed / isCachedDeployed", () => {
  it("isCachedDeployed returns false when not in cache", () => {
    const { dm } = makeManager();
    expect(dm.isCachedDeployed("hello.aleo")).toBe(false);
  });

  it("isCachedDeployed returns true after record()", async () => {
    const { dm } = makeManager();
    await dm.record(completeRecord, "deploy", { abi: mockAbi });
    expect(dm.isCachedDeployed("hello.aleo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pending recovery
// ---------------------------------------------------------------------------

describe("recoverPendingDeployments", () => {
  it("recovers a program on-chain — creates RecoveredDeploymentRecord", async () => {
    const source = "program hello.aleo;\nconstructor:\n    assert.eq edition 1u16;\n";
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(source),
    });
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(
      config,
      () => makeNetworkManager(conn),
      makeArtifactStore(),
    );

    const pending: PendingDeployment = {
      programId: "hello.aleo",
      action: "deploy",
      startedAt: "2026-01-01T00:00:00.000Z",
      expectedEdition: 1,
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: "abc123",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    };
    await dm.setPending(pending);

    const recovered = await dm.recoverPendingDeployments("devnode", conn);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe("recovered");
    expect(recovered[0]!.programId).toBe("hello.aleo");
    expect(recovered[0]!.historyCount).toBe(1);

    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("recovered");
    expect(onDisk?.historyCount).toBe(1);
    expect(readHistory(config.paths.deployments, "devnode", "hello.aleo")).toHaveLength(1);

    // Marker cleared
    const marker = readPendingMarker(config.paths.deployments, "devnode", "hello.aleo");
    expect(marker).toBeNull();
  });

  it("does not replace an already complete same-edition record during pending recovery", async () => {
    const source = "program hello.aleo;\nconstructor:\n    assert.eq edition 1u16;\n";
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(source),
    });
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(
      config,
      () => makeNetworkManager(conn),
      makeArtifactStore(),
    );

    await dm.record(completeRecord, "deploy", { abi: mockAbi });

    const pending: PendingDeployment = {
      programId: "hello.aleo",
      action: "deploy",
      startedAt: "2026-01-01T00:00:01.000Z",
      expectedEdition: 1,
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: "abc123",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    };
    await dm.setPending(pending);

    const recovered = await dm.recoverPendingDeployments("devnode", conn);
    expect(recovered).toHaveLength(0);

    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("complete");
    expect((onDisk as CompleteDeploymentRecord).txId).toBe("at1abc");
    expect(readHistory(config.paths.deployments, "devnode", "hello.aleo")).toHaveLength(1);
    expect(readPendingMarker(config.paths.deployments, "devnode", "hello.aleo")).toBeNull();
  });

  it("does not replace an already complete newer-edition record during pending recovery", async () => {
    const source = "program hello.aleo;\nconstructor:\n    assert.eq edition 2u16;\n";
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(source),
    });
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(
      config,
      () => makeNetworkManager(conn),
      makeArtifactStore(),
    );

    const edition2Record: CompleteDeploymentRecord = {
      ...completeRecord,
      edition: 2,
      historyCount: 2,
      txId: "at1edition2",
      blockHeight: 99,
    };
    writeDeploymentRecord(config.paths.deployments, "devnode", edition2Record);

    const pending: PendingDeployment = {
      programId: "hello.aleo",
      action: "upgrade",
      startedAt: "2026-01-01T00:00:01.000Z",
      expectedEdition: 1,
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: "abc123",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    };
    await dm.setPending(pending);

    const recovered = await dm.recoverPendingDeployments("devnode", conn);
    expect(recovered).toHaveLength(0);

    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("complete");
    expect(onDisk?.edition).toBe(2);
    expect((onDisk as CompleteDeploymentRecord).txId).toBe("at1edition2");
    expect(readPendingMarker(config.paths.deployments, "devnode", "hello.aleo")).toBeNull();
  });

  it("does not re-recover an already recovered same-edition record during pending recovery", async () => {
    const source = "program hello.aleo;\nconstructor:\n    assert.eq edition 2u16;\n";
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(source),
    });
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(
      config,
      () => makeNetworkManager(conn),
      makeArtifactStore(),
    );

    const recoveredRecord: RecoveredDeploymentRecord = {
      status: "recovered",
      programId: "hello.aleo",
      edition: 2,
      constructor: { type: "noupgrade" },
      abiHash: "new-abi-hash",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      updatedAt: "2026-01-01T00:00:02.000Z",
      historyCount: 1,
      txId: null,
      blockHeight: null,
      deployerAddress: "aleo1abc",
      deployedAt: "2026-01-01T00:00:01.000Z",
      feePaid: null,
    };
    await dm.record(recoveredRecord, "upgrade", {
      historyEntry: { action: "upgrade", previousEdition: 1 },
    });

    const pending: PendingDeployment = {
      programId: "hello.aleo",
      action: "upgrade",
      startedAt: "2026-01-01T00:00:01.000Z",
      expectedEdition: 2,
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: "new-abi-hash",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    };
    await dm.setPending(pending);

    const recovered = await dm.recoverPendingDeployments("devnode", conn);
    expect(recovered).toHaveLength(0);

    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("recovered");
    expect(onDisk?.edition).toBe(2);
    expect(onDisk?.historyCount).toBe(1);
    expect(readHistory(config.paths.deployments, "devnode", "hello.aleo")).toHaveLength(1);
    expect(readPendingMarker(config.paths.deployments, "devnode", "hello.aleo")).toBeNull();
  });

  it("does not re-recover an already recovered newer-edition record during pending recovery", async () => {
    const source = "program hello.aleo;\nconstructor:\n    assert.eq edition 3u16;\n";
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(source),
    });
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(
      config,
      () => makeNetworkManager(conn),
      makeArtifactStore(),
    );

    const recoveredRecord: RecoveredDeploymentRecord = {
      status: "recovered",
      programId: "hello.aleo",
      edition: 3,
      constructor: { type: "noupgrade" },
      abiHash: "newer-abi-hash",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      updatedAt: "2026-01-01T00:00:03.000Z",
      historyCount: 2,
      txId: null,
      blockHeight: null,
      deployerAddress: "aleo1abc",
      deployedAt: "2026-01-01T00:00:02.000Z",
      feePaid: null,
    };
    writeDeploymentRecord(config.paths.deployments, "devnode", recoveredRecord);

    const pending: PendingDeployment = {
      programId: "hello.aleo",
      action: "upgrade",
      startedAt: "2026-01-01T00:00:01.000Z",
      expectedEdition: 2,
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: "new-abi-hash",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    };
    await dm.setPending(pending);

    const recovered = await dm.recoverPendingDeployments("devnode", conn);
    expect(recovered).toHaveLength(0);

    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("recovered");
    expect(onDisk?.edition).toBe(3);
    expect(onDisk?.historyCount).toBe(2);
    expect(readHistory(config.paths.deployments, "devnode", "hello.aleo")).toHaveLength(0);
    expect(readPendingMarker(config.paths.deployments, "devnode", "hello.aleo")).toBeNull();
  });

  it("clears stale ABI snapshot when recovering an interrupted upgrade", async () => {
    const source = "program hello.aleo;\nconstructor:\n    assert.eq edition 2u16;\n";
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(source),
    });
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(
      config,
      () => makeNetworkManager(conn),
      makeArtifactStore(),
    );

    writeDeploymentRecord(config.paths.deployments, "devnode", completeRecord);
    writeAbiSnapshot(config.paths.deployments, "devnode", "hello.aleo", mockAbi);
    expect(readAbiSnapshot(config.paths.deployments, "devnode", "hello.aleo")).not.toBeNull();

    const pending: PendingDeployment = {
      programId: "hello.aleo",
      action: "upgrade",
      startedAt: "2026-01-01T00:00:01.000Z",
      expectedEdition: 2,
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: "new-abi-hash",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    };
    await dm.setPending(pending);

    const recovered = await dm.recoverPendingDeployments("devnode", conn);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.edition).toBe(2);
    expect(recovered[0]!.historyCount).toBe(1);

    const onDisk = readDeploymentRecord(config.paths.deployments, "devnode", "hello.aleo");
    expect(onDisk?.status).toBe("recovered");
    expect(onDisk?.edition).toBe(2);
    expect(onDisk?.abiHash).toBe("new-abi-hash");
    expect(readAbiSnapshot(config.paths.deployments, "devnode", "hello.aleo")).toBeNull();
    expect(dm.getCachedAbi("hello.aleo", "devnode")).toBeNull();
  });

  it("clears marker when program not on-chain (never broadcast)", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(
      config,
      () => makeNetworkManager(conn),
      makeArtifactStore(),
    );

    const pending: PendingDeployment = {
      programId: "hello.aleo",
      action: "deploy",
      startedAt: "2026-01-01T00:00:00.000Z",
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: null,
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    };
    await dm.setPending(pending);

    const recovered = await dm.recoverPendingDeployments("devnode", conn);
    expect(recovered).toHaveLength(0);

    // Marker cleared
    const marker = readPendingMarker(config.paths.deployments, "devnode", "hello.aleo");
    expect(marker).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("export()", () => {
  it("includes ABI from snapshot when available", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(compiledSource()),
    });
    const config = makeConfig({ ephemeral: false });
    const dm = new DeploymentManagerImpl(
      config,
      () => makeNetworkManager(conn),
      makeArtifactStore(),
    );

    await dm.record(completeRecord, "deploy", { abi: mockAbi });
    const bundle = await dm.export("devnode");

    expect(bundle.programs["hello.aleo"]).toBeDefined();
    expect(bundle.programs["hello.aleo"]!.abi).toEqual(mockAbi);
    expect(bundle.programs["hello.aleo"]!.status).toBe("complete");
  });

  it("falls back to artifact store when snapshot absent (HTTP export reads disk)", async () => {
    // Simulate a record on disk without an ABI snapshot — e.g., a deployment made
    // before ABI snapshot enforcement. HTTP export reads all disk records, so this
    // scenario is exercised via a testnet (HTTP) network where metadata validation passes.
    const artifacts = makeArtifactStore();
    (artifacts.getAbi as ReturnType<typeof vi.fn>).mockReturnValue(mockAbi);

    const config = makeHttpConfig();
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), artifacts);

    // Write disk record directly (no ABI snapshot alongside it)
    writeDeploymentRecord(config.paths.deployments, "testnet", {
      ...completeRecord,
      network: "testnet",
      endpoint: "https://api.example.com",
    });
    // Write network metadata so HTTP validation passes
    const { writeNetworkMetadata } = await import("./deployment-state.js");
    writeNetworkMetadata(config.paths.deployments, "testnet", {
      type: "http",
      networkId: "testnet",
      endpoint: "https://api.example.com",
    });

    const bundle = await dm.export("testnet");

    expect(bundle.programs["hello.aleo"]!.abi).toEqual(mockAbi);
  });
});

// ---------------------------------------------------------------------------
// invalidateSession
// ---------------------------------------------------------------------------

describe("invalidateSession()", () => {
  it("clears cache for the target network", async () => {
    const { dm } = makeManager();
    await dm.record(completeRecord, "deploy", { abi: mockAbi });
    expect(dm.getCached("hello.aleo")).not.toBeNull();

    dm.invalidateSession("devnode");
    expect(dm.getCached("hello.aleo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ABI cache normalization
// ---------------------------------------------------------------------------

describe("getCachedAbi() normalization", () => {
  it("normalizes compiler-format ABI (functions key) to internal format (transitions key)", async () => {
    // The ArtifactStore's lazy disk fallback returns raw JSON.parse() output, which
    // uses the Leo compiler's `functions` key instead of the internal `transitions` key.
    // record() must normalize via parseAbi() so getCachedAbi() always returns a fully
    // normalized ProgramABI — otherwise upgrade ABI compatibility checks fail with
    // "oldItems is not iterable" when iterating oldAbi.transitions.
    const { dm } = makeManager({ ephemeral: true });

    const compilerFormatAbi = {
      program: "hello.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      functions: [{ name: "increment", is_final: true, inputs: [], outputs: [] }],
    } as unknown as ProgramABI; // compiler format — has `functions`, not `transitions`

    await dm.record(completeRecord, "deploy", { abi: compilerFormatAbi });

    const cached = dm.getCachedAbi("hello.aleo", "devnode");
    expect(cached).not.toBeNull();

    // Must have `transitions` (internal format), not raw `functions`
    expect(cached!.transitions).toBeDefined();
    expect(Array.isArray(cached!.transitions)).toBe(true);
    expect(cached!.transitions).toHaveLength(1);
    expect(cached!.transitions[0]!.name).toBe("increment");

    // The raw `functions` key must NOT leak through to the cached ABI
    expect((cached as any)["functions"]).toBeUndefined();
  });
});
