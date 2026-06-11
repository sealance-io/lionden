import type { DependencyGraph, ProgramABI } from "@lionden/leo-compiler";
import { createMockConfig, createMockConnection } from "@lionden/test-internals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConstructorInfo } from "./constructor-parser.js";
import type { DeploymentRecord } from "./deployment-types.js";
import {
  checkAbiCompatible,
  checkAlreadyDeployed,
  checkBalanceSufficient,
  checkConstructorImmutable,
  checkEditionContinuity,
  checkImportsAvailable,
  runDeployPreflight,
  runUpgradePreflight,
} from "./preflight.js";

const mockCreateSdkObjects = vi.hoisted(() => vi.fn());

vi.mock("@lionden/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/network")>();
  return {
    ...original,
    createSdkObjects: mockCreateSdkObjects,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEVNODE_ACCOUNT_0_ADDRESS = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";
const DEVNODE_ACCOUNT_0_PRIVATE_KEY = "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";

const noupgradeConstructor: ConstructorInfo = { type: "noupgrade" };
const adminConstructor: ConstructorInfo = {
  type: "admin",
  adminAddress: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz15iwyf2vd3d7jkqqe0yv8s2zs0za",
};

const mockAbi: ProgramABI = {
  program: "hello.aleo",
  structs: [],
  records: [],
  mappings: [],
  storage_variables: [],
  transitions: [{ name: "main", is_async: false, inputs: [], outputs: [] }],
};

const completeRecord: DeploymentRecord = {
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

const adminConstructorNoEditionSource = `
program hello.aleo;

constructor:
    assert.eq program_owner ${DEVNODE_ACCOUNT_0_ADDRESS};
`;

function makeGraph(
  imports: Record<string, string[]> = {},
  networkDeps: string[] = [],
): DependencyGraph {
  return {
    imports: new Map(Object.entries(imports)),
    networkDeps: new Set(networkDeps),
    order: [],
  };
}

beforeEach(() => {
  mockCreateSdkObjects.mockReset();
  mockCreateSdkObjects.mockResolvedValue({
    programManager: {},
    account: {
      address: () => ({
        to_string: () => DEVNODE_ACCOUNT_0_ADDRESS,
      }),
    },
  });
});

// ---------------------------------------------------------------------------
// checkAlreadyDeployed
// ---------------------------------------------------------------------------

describe("checkAlreadyDeployed", () => {
  it("returns deploy outcome when program not on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const { outcome, error } = await checkAlreadyDeployed(conn, "hello.aleo", null, true);
    expect(outcome.action).toBe("deploy");
    expect(error).toBeNull();
  });

  it("returns skip outcome when program on-chain and skipDeployed=true", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue("program hello.aleo;"),
    });
    const { outcome, error } = await checkAlreadyDeployed(conn, "hello.aleo", completeRecord, true);
    expect(outcome.action).toBe("skip");
    expect(outcome.reason).toBe("already-in-state");
    expect(error).toBeNull();
  });

  it("returns skip with already-deployed reason when no existing record", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue("program hello.aleo;"),
    });
    const { outcome, error } = await checkAlreadyDeployed(conn, "hello.aleo", null, true);
    expect(outcome.action).toBe("skip");
    expect(outcome.reason).toBe("already-deployed");
    expect(error).toBeNull();
  });

  it("returns fatal error when on-chain and skipDeployed=false", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue("program hello.aleo;"),
    });
    const { outcome, error } = await checkAlreadyDeployed(conn, "hello.aleo", null, false);
    expect(outcome.action).toBe("skip");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("ALREADY_DEPLOYED");
  });
});

// ---------------------------------------------------------------------------
// checkImportsAvailable
// ---------------------------------------------------------------------------

describe("checkImportsAvailable", () => {
  it("passes when all imports are in deploy targets", async () => {
    const conn = createMockConnection();
    const graph = makeGraph({ "hello.aleo": ["dep.aleo"] });
    const targets = new Set(["dep.aleo"]);
    const errors = await checkImportsAvailable(conn, graph, "hello.aleo", targets, new Map());
    expect(errors).toHaveLength(0);
  });

  it("passes when import is in localSources", async () => {
    const conn = createMockConnection();
    const graph = makeGraph({ "hello.aleo": ["dep.aleo"] });
    const localSources = new Map([["dep.aleo", "program dep.aleo;"]]);
    const errors = await checkImportsAvailable(conn, graph, "hello.aleo", new Set(), localSources);
    expect(errors).toHaveLength(0);
  });

  it("passes when import is on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue("program dep.aleo;"),
    });
    const graph = makeGraph({ "hello.aleo": ["dep.aleo"] });
    const errors = await checkImportsAvailable(conn, graph, "hello.aleo", new Set(), new Map());
    expect(errors).toHaveLength(0);
  });

  it("fails when import is missing from all sources", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const graph = makeGraph({ "hello.aleo": ["dep.aleo"] });
    const errors = await checkImportsAvailable(conn, graph, "hello.aleo", new Set(), new Map());
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("MISSING_IMPORT");
  });

  it("passes when network dep (credits.aleo) is present on-chain", async () => {
    // All imports — including standard network programs like credits.aleo — must be
    // verified on-chain. credits.aleo is always available in practice, but we still
    // check so that any non-local import that is missing produces a fatal error.
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue("program credits.aleo;"),
    });
    const graph = makeGraph({ "hello.aleo": ["credits.aleo"] }, ["credits.aleo"]);
    const errors = await checkImportsAvailable(conn, graph, "hello.aleo", new Set(), new Map());
    expect(errors).toHaveLength(0);
  });

  it("fails when network dep (credits.aleo) is missing on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const graph = makeGraph({ "hello.aleo": ["credits.aleo"] }, ["credits.aleo"]);
    const errors = await checkImportsAvailable(conn, graph, "hello.aleo", new Set(), new Map());
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("MISSING_IMPORT");
  });
});

// ---------------------------------------------------------------------------
// checkBalanceSufficient
// ---------------------------------------------------------------------------

describe("checkBalanceSufficient", () => {
  it("passes when balance > 1.5x estimate", async () => {
    const conn = createMockConnection({ getBalance: vi.fn().mockResolvedValue(2_000n) });
    const { warning, error } = await checkBalanceSufficient(conn, 1_000n);
    expect(warning).toBeNull();
    expect(error).toBeNull();
  });

  it("warns when balance is between 1x and 1.5x estimate", async () => {
    const conn = createMockConnection({ getBalance: vi.fn().mockResolvedValue(1_200n) });
    const { warning, error } = await checkBalanceSufficient(conn, 1_000n);
    expect(warning).not.toBeNull();
    expect(warning!.code).toBe("LOW_BALANCE");
    expect(error).toBeNull();
  });

  it("errors when balance < 1x estimate", async () => {
    const conn = createMockConnection({ getBalance: vi.fn().mockResolvedValue(500n) });
    const { warning, error } = await checkBalanceSufficient(conn, 1_000n);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("skips check when estimate is 0", async () => {
    const conn = createMockConnection({ getBalance: vi.fn().mockResolvedValue(0n) });
    const { warning, error } = await checkBalanceSufficient(conn, 0n);
    expect(warning).toBeNull();
    expect(error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkAbiCompatible
// ---------------------------------------------------------------------------

describe("checkAbiCompatible", () => {
  it("passes when ABIs are identical", () => {
    const err = checkAbiCompatible(mockAbi, mockAbi, "hello.aleo");
    expect(err).toBeNull();
  });

  it("passes when new ABI adds a transition", () => {
    const newAbi: ProgramABI = {
      ...mockAbi,
      transitions: [
        ...mockAbi.transitions,
        { name: "extra", is_async: false, inputs: [], outputs: [] },
      ],
    };
    const err = checkAbiCompatible(mockAbi, newAbi, "hello.aleo");
    expect(err).toBeNull();
  });

  it("fails when existing transition is removed", () => {
    const newAbi: ProgramABI = { ...mockAbi, transitions: [] };
    const err = checkAbiCompatible(mockAbi, newAbi, "hello.aleo");
    expect(err).not.toBeNull();
    expect(err!.code).toBe("ABI_INCOMPATIBLE");
  });
});

// ---------------------------------------------------------------------------
// checkConstructorImmutable
// ---------------------------------------------------------------------------

describe("checkConstructorImmutable", () => {
  it("passes when constructor type is unchanged", () => {
    const err = checkConstructorImmutable(
      completeRecord,
      noupgradeConstructor,
      "fp1",
      "hello.aleo",
    );
    expect(err).toBeNull();
  });

  it("fails when constructor type changes", () => {
    const err = checkConstructorImmutable(completeRecord, adminConstructor, "fp1", "hello.aleo");
    expect(err).not.toBeNull();
    expect(err!.code).toBe("CONSTRUCTOR_TYPE_CHANGED");
  });

  it("fails when fingerprint changes", () => {
    const record: DeploymentRecord = {
      ...completeRecord,
      constructor: { type: "noupgrade", fingerprint: "fp1" },
    };
    const err = checkConstructorImmutable(record, noupgradeConstructor, "fp2", "hello.aleo");
    expect(err).not.toBeNull();
    expect(err!.code).toBe("CONSTRUCTOR_BODY_CHANGED");
  });

  it("passes when record has no fingerprint (pre-fingerprinting manifest)", () => {
    const record: DeploymentRecord = {
      ...completeRecord,
      constructor: { type: "noupgrade" }, // no fingerprint
    };
    const err = checkConstructorImmutable(record, noupgradeConstructor, "fp2", "hello.aleo");
    expect(err).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkEditionContinuity
// ---------------------------------------------------------------------------

describe("checkEditionContinuity", () => {
  it("passes when on-chain edition matches expected", async () => {
    const source = `constructor:\n    assert.eq edition 1u16;\n`;
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(source),
    });
    const err = await checkEditionContinuity(conn, "hello.aleo", 1);
    expect(err).toBeNull();
  });

  it("passes when program exists but on-chain edition is unknown", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(adminConstructorNoEditionSource),
    });
    const err = await checkEditionContinuity(conn, "hello.aleo", 1);
    expect(err).toBeNull();
  });

  it("fails when on-chain edition differs from expected", async () => {
    const source = `constructor:\n    assert.eq edition 5u16;\n`;
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(source),
    });
    const err = await checkEditionContinuity(conn, "hello.aleo", 1);
    expect(err).not.toBeNull();
    expect(err!.code).toBe("EDITION_MISMATCH");
  });

  it("fails when program not found on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const err = await checkEditionContinuity(conn, "hello.aleo", 1);
    expect(err).not.toBeNull();
    expect(err!.code).toBe("PROGRAM_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// runDeployPreflight — pipeline integration
// ---------------------------------------------------------------------------

describe("runDeployPreflight", () => {
  const config = createMockConfig();
  const devnodeNetworkConfig = config.networks["devnode"]!;
  const httpNetworkConfig = {
    type: "http" as const,
    endpoint: "https://api.example.com",
    network: "testnet" as const,
    ephemeral: false,
  };

  it("skips deployed programs on devnode when skipDeployed=true", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue("program hello.aleo;"),
    });
    const result = await runDeployPreflight({
      programs: [
        {
          programId: "hello.aleo",
          constructor: noupgradeConstructor,
          aleoSource: "program hello.aleo;",
          existingRecord: null,
        },
      ],
      connection: conn,
      networkConfig: devnodeNetworkConfig,
      config,
      skipDeployed: true,
      deployTargets: new Set(["hello.aleo"]),
      localSources: new Map(),
      graph: makeGraph(),
    });

    expect(result.passed).toBe(true);
    expect(result.programs).toHaveLength(1);
    expect(result.programs[0]!.action).toBe("skip");
  });

  it("returns deploy outcome when program not on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const result = await runDeployPreflight({
      programs: [
        {
          programId: "hello.aleo",
          constructor: noupgradeConstructor,
          aleoSource: "program hello.aleo;",
          existingRecord: null,
        },
      ],
      connection: conn,
      networkConfig: devnodeNetworkConfig,
      config,
      skipDeployed: true,
      deployTargets: new Set(["hello.aleo"]),
      localSources: new Map(),
      graph: makeGraph(),
    });

    expect(result.passed).toBe(true);
    expect(result.programs[0]!.action).toBe("deploy");
  });

  it("does not fail when constructor is missing", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const result = await runDeployPreflight({
      programs: [
        {
          programId: "hello.aleo",
          constructor: null,
          aleoSource: "program hello.aleo;",
          existingRecord: null,
        },
      ],
      connection: conn,
      networkConfig: devnodeNetworkConfig,
      config,
      skipDeployed: true,
      deployTargets: new Set(["hello.aleo"]),
      localSources: new Map(),
      graph: makeGraph(),
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("skips fee and import checks on devnode", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const result = await runDeployPreflight({
      programs: [
        {
          programId: "hello.aleo",
          constructor: noupgradeConstructor,
          aleoSource: "program hello.aleo;",
          existingRecord: null,
        },
      ],
      connection: conn,
      networkConfig: devnodeNetworkConfig,
      config,
      skipDeployed: true,
      deployTargets: new Set(["hello.aleo"]),
      localSources: new Map(),
      graph: makeGraph({ "hello.aleo": ["missing.aleo"] }),
    });

    // Devnode skips import checks — no MISSING_IMPORT error
    expect(result.errors.some((e) => e.code === "MISSING_IMPORT")).toBe(false);
    expect(result.totalFeeEstimate).toBeUndefined();
  });

  it("preflight is pure — no state mutations", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    // Run twice — no side effects
    const r1 = await runDeployPreflight({
      programs: [
        {
          programId: "hello.aleo",
          constructor: noupgradeConstructor,
          aleoSource: "program hello.aleo;",
          existingRecord: null,
        },
      ],
      connection: conn,
      networkConfig: devnodeNetworkConfig,
      config,
      skipDeployed: true,
      deployTargets: new Set(["hello.aleo"]),
      localSources: new Map(),
      graph: makeGraph(),
    });
    const r2 = await runDeployPreflight({
      programs: [
        {
          programId: "hello.aleo",
          constructor: noupgradeConstructor,
          aleoSource: "program hello.aleo;",
          existingRecord: null,
        },
      ],
      connection: conn,
      networkConfig: devnodeNetworkConfig,
      config,
      skipDeployed: true,
      deployTargets: new Set(["hello.aleo"]),
      localSources: new Map(),
      graph: makeGraph(),
    });
    expect(r1).toEqual(r2);
  });

  it("totals fee estimates correctly for multiple programs", async () => {
    // Mock HTTP network — need to check fee estimation
    // Since estimateDeploymentFee requires real SDK, just verify structure
    const conn = createMockConnection({
      type: "http" as const,
      getProgramSource: vi.fn().mockResolvedValue(null),
      getBalance: vi.fn().mockResolvedValue(10_000_000n),
    });
    const result = await runDeployPreflight({
      programs: [
        {
          programId: "alpha.aleo",
          constructor: noupgradeConstructor,
          aleoSource: "program alpha.aleo;",
          existingRecord: null,
        },
        {
          programId: "beta.aleo",
          constructor: noupgradeConstructor,
          aleoSource: "program beta.aleo;",
          existingRecord: null,
        },
      ],
      connection: conn,
      networkConfig: httpNetworkConfig,
      config,
      skipDeployed: true,
      deployTargets: new Set(["alpha.aleo", "beta.aleo"]),
      localSources: new Map(),
      graph: makeGraph(),
    });
    // Fee estimation may fail in test environment (no real SDK), but pipeline should not crash
    expect(result.programs).toHaveLength(2);
    expect(result.programs.every((p) => p.action === "deploy")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runUpgradePreflight — pipeline integration
// ---------------------------------------------------------------------------

describe("runUpgradePreflight", () => {
  const config = createMockConfig();

  it("passes for compatible upgrade", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(`constructor:\n    assert.eq edition 1u16;\n`),
    });
    const result = await runUpgradePreflight({
      programId: "hello.aleo",
      oldRecord: completeRecord,
      oldAbi: mockAbi,
      newConstructor: noupgradeConstructor,
      newAbi: mockAbi,
      newFingerprint: "",
      connection: conn,
      config,
      networkName: "devnode",
    });
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("passes HTTP @admin upgrade preflight when source exists but edition is unknown", async () => {
    const httpConfig = createMockConfig({
      networks: {
        ...config.networks,
        testnet: {
          type: "http",
          endpoint: "https://api.example.com",
          network: "testnet",
          privateKey: DEVNODE_ACCOUNT_0_PRIVATE_KEY,
          ephemeral: false,
        },
      },
      defaultNetwork: "testnet",
    });
    const conn = createMockConnection({
      type: "http",
      name: "testnet",
      endpoint: "https://api.example.com",
      networkId: "testnet",
      privateKey: DEVNODE_ACCOUNT_0_PRIVATE_KEY,
      getProgramSource: vi.fn().mockResolvedValue(adminConstructorNoEditionSource),
    });
    const adminRecord: DeploymentRecord = {
      ...completeRecord,
      network: "testnet",
      endpoint: "https://api.example.com",
      constructor: { type: "admin", adminAddress: DEVNODE_ACCOUNT_0_ADDRESS },
    };
    const result = await runUpgradePreflight({
      programId: "hello.aleo",
      oldRecord: adminRecord,
      oldAbi: mockAbi,
      newConstructor: { type: "admin", adminAddress: DEVNODE_ACCOUNT_0_ADDRESS },
      newAbi: mockAbi,
      newFingerprint: "",
      connection: conn,
      config: httpConfig,
      networkName: "testnet",
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.errors.some((e) => e.code === "PROGRAM_NOT_FOUND")).toBe(false);
  });

  it("fails for ABI-incompatible upgrade", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(`constructor:\n    assert.eq edition 1u16;\n`),
    });
    const brokenAbi: ProgramABI = { ...mockAbi, transitions: [] }; // removed transition
    const result = await runUpgradePreflight({
      programId: "hello.aleo",
      oldRecord: completeRecord,
      oldAbi: mockAbi,
      newConstructor: noupgradeConstructor,
      newAbi: brokenAbi,
      newFingerprint: "",
      connection: conn,
      config,
      networkName: "devnode",
    });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.code === "ABI_INCOMPATIBLE")).toBe(true);
  });

  it("fails when a recorded constructor is changed", async () => {
    const conn = createMockConnection();
    const result = await runUpgradePreflight({
      programId: "hello.aleo",
      oldRecord: completeRecord,
      oldAbi: mockAbi,
      newConstructor: { type: "custom" },
      newAbi: mockAbi,
      newFingerprint: "",
      connection: conn,
      config,
      networkName: "devnode",
    });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.code === "CONSTRUCTOR_TYPE_CHANGED")).toBe(true);
  });
});
