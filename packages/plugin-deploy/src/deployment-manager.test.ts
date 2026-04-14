import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockConfig } from "@lionden/test-internals";
import { createMockConnection } from "@lionden/test-internals";
import type { ArtifactStore } from "@lionden/core";
import type { NetworkManager } from "@lionden/network";
import { DeploymentManagerImpl } from "./deployment-manager.js";
import {
  writeDeploymentRecord,
  readPendingMarker,
  readAbiSnapshot,
  readNetworkMetadata,
} from "./deployment-state.js";
import type {
  CompleteDeploymentRecord,
  DegradedDeploymentRecord,
  PendingDeployment,
} from "./deployment-types.js";
import type { ProgramABI } from "@lionden/leo-compiler";

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

function makeConfig(networkType: "devnode" | "http" = "devnode") {
  if (networkType === "devnode") {
    return createMockConfig({ root: tmpDir });
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
    execute: vi.fn(),
    getMappingValue: vi.fn(),
  };
}

function makeManager(opts: {
  networkType?: "devnode" | "http";
  connection?: ReturnType<typeof createMockConnection>;
  networkManager?: NetworkManager;
  artifacts?: ArtifactStore;
} = {}) {
  const config = opts.networkType === "http" ? makeHttpConfig() : makeConfig();
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
      getProgramSource: vi.fn().mockResolvedValue("program hello.aleo;\nconstructor:\n    assert.eq edition 1u16;\n"),
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
      getProgramSource: vi.fn().mockResolvedValue("program hello.aleo;\nconstructor:\n    assert.eq edition 2u16;\n"),
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
    const managerWithNull: NetworkManager = {
      connect: vi.fn(),
      getConnection: vi.fn().mockReturnValue(null),
      disconnectAll: vi.fn(),
      getAccounts: vi.fn().mockReturnValue([]),
      execute: vi.fn(),
      getMappingValue: vi.fn(),
    };
    const dm2 = new DeploymentManagerImpl(makeConfig(), () => managerWithNull, makeArtifactStore());

    // Nothing in cache
    const result = await dm2.getDeployment("hello.aleo");
    expect(result).toBeNull();
  });

  it("getAllDeployments returns cache-only for devnode", async () => {
    const conn = createMockConnection({ getProgramSource: vi.fn().mockResolvedValue(null) });
    const config = makeConfig();
    const manager = makeNetworkManager(conn);
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    // Write disk state (should be ignored)
    writeDeploymentRecord(config.paths.deployments, "devnode", completeRecord);

    // Nothing in cache
    const records = await dm.getAllDeployments();
    expect(records).toHaveLength(0);
  });

  it("export returns cache-only programs for devnode", async () => {
    const config = makeConfig();
    const manager = makeNetworkManager();
    const dm = new DeploymentManagerImpl(config, () => manager, makeArtifactStore());

    // Record something to populate cache
    await dm.record({ ...completeRecord, network: "devnode" }, "deploy", { abi: mockAbi });
    const bundle = await dm.export("devnode");

    expect(Object.keys(bundle.programs)).toHaveLength(1);
    expect(bundle.programs["hello.aleo"]).toBeDefined();
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

    await dm.record({ ...completeRecord, network: "testnet", endpoint: "https://api.example.com" }, "deploy", { abi: mockAbi });

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
    const config = makeConfig();
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
    const config = makeConfig();
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(conn), makeArtifactStore());

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

    // Marker cleared
    const marker = readPendingMarker(config.paths.deployments, "devnode", "hello.aleo");
    expect(marker).toBeNull();
  });

  it("clears marker when program not on-chain (never broadcast)", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const config = makeConfig();
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(conn), makeArtifactStore());

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
    const config = makeConfig();
    const dm = new DeploymentManagerImpl(config, () => makeNetworkManager(), makeArtifactStore());

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
