import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProgramABI } from "@lionden/leo-compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendHistory,
  deletePendingMarker,
  listPendingMarkers,
  readAbiSnapshot,
  readAllDeploymentRecords,
  readDeploymentRecord,
  readHistory,
  readNetworkMetadata,
  readPendingMarker,
  writeAbiSnapshot,
  writeDeploymentRecord,
  writeExportBundle,
  writeNetworkMetadata,
  writePendingMarker,
} from "./deployment-state.js";
import type {
  CompleteDeploymentRecord,
  DegradedDeploymentRecord,
  DeploymentHistoryEntry,
  ExportBundle,
  NetworkMetadata,
  PendingDeployment,
  RecoveredDeploymentRecord,
} from "./deployment-types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-state-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeComplete(): CompleteDeploymentRecord {
  return {
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
    feePaid: 0,
  };
}

function makeDegraded(): DegradedDeploymentRecord {
  return {
    status: "degraded",
    programId: "hello.aleo",
    edition: 2,
    constructor: { type: null },
    abiHash: null,
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    updatedAt: "2026-01-01T00:00:00.000Z",
    historyCount: 0,
    txId: null,
    blockHeight: null,
    deployerAddress: null,
    deployedAt: null,
    feePaid: null,
  };
}

function makeRecovered(): RecoveredDeploymentRecord {
  return {
    status: "recovered",
    programId: "hello.aleo",
    edition: 1,
    constructor: { type: "admin", adminAddress: "aleo1admin" },
    abiHash: "abc123",
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    updatedAt: "2026-01-01T00:00:00.000Z",
    historyCount: 0,
    txId: null,
    blockHeight: null,
    deployerAddress: "aleo1deployer",
    deployedAt: "2026-01-01T00:00:00.000Z",
    feePaid: null,
  };
}

const mockAbi: ProgramABI = {
  program: "hello.aleo",
  structs: [],
  records: [],
  mappings: [],
  storage_variables: [],
  transitions: [],
};

// ---------------------------------------------------------------------------
// Deployment records
// ---------------------------------------------------------------------------

describe("writeDeploymentRecord / readDeploymentRecord", () => {
  it("round-trips a complete record", () => {
    const record = makeComplete();
    writeDeploymentRecord(tmpDir, "devnode", record);
    const got = readDeploymentRecord(tmpDir, "devnode", "hello.aleo");
    expect(got).toEqual(record);
  });

  it("round-trips a degraded record", () => {
    const record = makeDegraded();
    writeDeploymentRecord(tmpDir, "devnode", record);
    const got = readDeploymentRecord(tmpDir, "devnode", "hello.aleo");
    expect(got).toEqual(record);
  });

  it("round-trips a recovered record", () => {
    const record = makeRecovered();
    writeDeploymentRecord(tmpDir, "devnode", record);
    const got = readDeploymentRecord(tmpDir, "devnode", "hello.aleo");
    expect(got).toEqual(record);
  });

  it("returns null for non-existent record", () => {
    expect(readDeploymentRecord(tmpDir, "devnode", "missing.aleo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readAllDeploymentRecords
// ---------------------------------------------------------------------------

describe("readAllDeploymentRecords", () => {
  it("returns empty array when directory does not exist", () => {
    expect(readAllDeploymentRecords(tmpDir, "devnode")).toEqual([]);
  });

  it("returns all records, excluding .abi.json files", () => {
    const complete = makeComplete();
    writeDeploymentRecord(tmpDir, "devnode", complete);
    writeAbiSnapshot(tmpDir, "devnode", "hello.aleo", mockAbi);

    const other: CompleteDeploymentRecord = { ...complete, programId: "other.aleo" };
    writeDeploymentRecord(tmpDir, "devnode", other);

    const records = readAllDeploymentRecords(tmpDir, "devnode");
    expect(records).toHaveLength(2);
    const ids = records.map((r) => r.programId).sort();
    expect(ids).toEqual(["hello.aleo", "other.aleo"]);
  });

  it("excludes dotfiles like .network.json", () => {
    writeDeploymentRecord(tmpDir, "devnode", makeComplete());
    writeNetworkMetadata(tmpDir, "devnode", {
      type: "devnode",
      networkId: "testnet",
      endpoint: "http://127.0.0.1:3030",
    });

    const records = readAllDeploymentRecords(tmpDir, "devnode");
    expect(records).toHaveLength(1);
    expect(records[0]!.programId).toBe("hello.aleo");
  });
});

// ---------------------------------------------------------------------------
// ABI snapshots
// ---------------------------------------------------------------------------

describe("writeAbiSnapshot / readAbiSnapshot", () => {
  it("round-trips an ABI snapshot", () => {
    writeAbiSnapshot(tmpDir, "devnode", "hello.aleo", mockAbi);
    const got = readAbiSnapshot(tmpDir, "devnode", "hello.aleo");
    expect(got).toEqual(mockAbi);
  });

  it("returns null when snapshot does not exist", () => {
    expect(readAbiSnapshot(tmpDir, "devnode", "missing.aleo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("appendHistory / readHistory", () => {
  it("appends and reads entries in order", async () => {
    const record1 = makeComplete();
    const entry1: DeploymentHistoryEntry = { record: record1, action: "deploy" };
    appendHistory(tmpDir, "devnode", "hello.aleo", entry1);

    // Small delay to ensure different timestamps in filenames
    await new Promise((r) => setTimeout(r, 10));

    const record2: CompleteDeploymentRecord = { ...record1, edition: 2 };
    const entry2: DeploymentHistoryEntry = {
      record: record2,
      action: "upgrade",
      previousEdition: 1,
    };
    appendHistory(tmpDir, "devnode", "hello.aleo", entry2);

    const history = readHistory(tmpDir, "devnode", "hello.aleo");
    expect(history).toHaveLength(2);
    expect(history[0]!.action).toBe("deploy");
    expect(history[1]!.action).toBe("upgrade");
    expect(history[1]!.previousEdition).toBe(1);
  });

  it("returns empty array when no history exists", () => {
    expect(readHistory(tmpDir, "devnode", "hello.aleo")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Network metadata
// ---------------------------------------------------------------------------

describe("writeNetworkMetadata / readNetworkMetadata", () => {
  it("round-trips network metadata", () => {
    const meta: NetworkMetadata = {
      type: "http",
      networkId: "testnet",
      endpoint: "https://api.example.com",
    };
    writeNetworkMetadata(tmpDir, "testnet", meta);
    const got = readNetworkMetadata(tmpDir, "testnet");
    expect(got).toEqual(meta);
  });

  it("returns null when metadata does not exist", () => {
    expect(readNetworkMetadata(tmpDir, "devnode")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pending markers
// ---------------------------------------------------------------------------

describe("pending marker lifecycle", () => {
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

  it("write / read round-trip", () => {
    writePendingMarker(tmpDir, "devnode", pending);
    const got = readPendingMarker(tmpDir, "devnode", "hello.aleo");
    expect(got).toEqual(pending);
  });

  it("returns null when marker does not exist", () => {
    expect(readPendingMarker(tmpDir, "devnode", "missing.aleo")).toBeNull();
  });

  it("delete removes the marker", () => {
    writePendingMarker(tmpDir, "devnode", pending);
    deletePendingMarker(tmpDir, "devnode", "hello.aleo");
    expect(readPendingMarker(tmpDir, "devnode", "hello.aleo")).toBeNull();
  });

  it("delete is no-op when marker does not exist", () => {
    // Should not throw
    expect(() => deletePendingMarker(tmpDir, "devnode", "missing.aleo")).not.toThrow();
  });
});

describe("listPendingMarkers", () => {
  it("returns empty array when no markers exist", () => {
    expect(listPendingMarkers(tmpDir, "devnode")).toEqual([]);
  });

  it("lists pending program IDs", () => {
    const make = (id: string): PendingDeployment => ({
      programId: id,
      action: "deploy",
      startedAt: "2026-01-01T00:00:00.000Z",
      deployerAddress: "aleo1abc",
      priorityFee: 0,
      privateFee: false,
      constructor: { type: "noupgrade" },
      abiHash: null,
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
    });

    writePendingMarker(tmpDir, "devnode", make("alpha.aleo"));
    writePendingMarker(tmpDir, "devnode", make("beta.aleo"));

    const ids = listPendingMarkers(tmpDir, "devnode").sort();
    expect(ids).toEqual(["alpha.aleo", "beta.aleo"]);
  });
});

// ---------------------------------------------------------------------------
// Export bundles
// ---------------------------------------------------------------------------

describe("writeExportBundle", () => {
  it("writes an export bundle to deployments/_exports/<network>.json", () => {
    const bundle: ExportBundle = {
      network: "devnode",
      networkInfo: { type: "devnode", networkId: "testnet", endpoint: "http://127.0.0.1:3030" },
      exportedAt: "2026-01-01T00:00:00.000Z",
      programs: {
        "hello.aleo": {
          programId: "hello.aleo",
          abi: mockAbi,
          edition: 1,
          txId: "at1abc",
          constructorType: "noupgrade",
          status: "complete",
        },
      },
    };
    writeExportBundle(tmpDir, "devnode", bundle);

    const exportBundlePath = path.join(tmpDir, "_exports", "devnode.json");
    expect(fs.readFileSync(exportBundlePath, "utf-8")).toBe(JSON.stringify(bundle, null, 2) + "\n");
  });
});
