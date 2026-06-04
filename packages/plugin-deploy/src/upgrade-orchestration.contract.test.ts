import type { LionDenPlugin } from "@lionden/core";
import { task } from "@lionden/core";
import type { ProgramABI } from "@lionden/leo-compiler";
import type { NetworkManager } from "@lionden/network";
import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractConstructorFingerprint } from "./constructor-parser.js";
import { DeploymentManagerImpl } from "./deployment-manager.js";
import { writeAbiSnapshot } from "./deployment-state.js";
import type { CompleteDeploymentRecord } from "./deployment-types.js";
import { DeployError } from "./errors.js";
import { UpgradeCompatibilityError, upgradeAction } from "./upgrade-task.js";

const DEVNODE_ACCOUNT_0 = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

const mockCreateSdkObjects = vi.hoisted(() => vi.fn());
const mockBuildDevnodeUpgradeTransaction = vi.hoisted(() => vi.fn());
const mockBuildUpgradeTransaction = vi.hoisted(() => vi.fn());

// Mock @lionden/network's SDK layer — upgrade-specific builders
vi.mock("@lionden/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/network")>();
  return {
    ...original,
    createSdkObjects: mockCreateSdkObjects,
    checkDevnodeSdkSupport: vi.fn().mockResolvedValue(undefined),
    initConsensusHeights: vi.fn().mockResolvedValue(undefined),
    DEVNODE_ACCOUNTS: [
      {
        address: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
        privateKey: "test-key",
      },
    ],
  };
});

/** Minimal ABI with one mapping and one transition. */
function makeAbi(opts?: { mappings?: string[]; records?: ProgramABI["records"] }): ProgramABI {
  const mappings = (opts?.mappings ?? ["counters"]).map((name) => ({
    name,
    key: { Primitive: "Address" } as const,
    value: { Primitive: { UInt: "U64" } } as const,
  }));

  return {
    program: "hello.aleo",
    transitions: [{ name: "increment", inputs: [], outputs: [], is_async: false }],
    structs: [],
    records: opts?.records ?? [],
    mappings,
    storage_variables: [],
  };
}

/** Build a complete deployment record for testing. */
function makeRecord(opts?: {
  constructorType?: "admin" | "noupgrade" | "checksum" | "custom";
  edition?: number;
  fingerprint?: string;
  network?: string;
  endpoint?: string;
}): CompleteDeploymentRecord {
  const type = opts?.constructorType ?? "admin";
  return {
    status: "complete",
    programId: "hello.aleo",
    network: opts?.network ?? "devnode",
    endpoint: opts?.endpoint ?? "http://127.0.0.1:3030",
    txId: "at1original",
    blockHeight: 1,
    edition: opts?.edition ?? 0,
    constructor: {
      type,
      adminAddress: type === "admin" ? DEVNODE_ACCOUNT_0 : undefined,
      checksumMapping: type === "checksum" ? "gov.aleo::checksums" : undefined,
      checksumKey: type === "checksum" ? "hello" : undefined,
      fingerprint: opts?.fingerprint,
    },
    abiHash: null,
    deployerAddress: DEVNODE_ACCOUNT_0,
    deployedAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    historyCount: 1,
  };
}

describe("upgrade orchestration contract", () => {
  let fixture: ContractLreResult;

  beforeEach(() => {
    delete process.env["LIONDEN_PROVE"];
    mockCreateSdkObjects.mockReset();
    mockBuildDevnodeUpgradeTransaction.mockReset();
    mockBuildUpgradeTransaction.mockReset();

    mockBuildDevnodeUpgradeTransaction.mockResolvedValue("devnode-upgrade-tx-bytes");
    mockBuildUpgradeTransaction.mockResolvedValue("standard-upgrade-tx-bytes");
    mockCreateSdkObjects.mockResolvedValue({
      programManager: {
        buildDevnodeUpgradeTransaction: mockBuildDevnodeUpgradeTransaction,
        buildUpgradeTransaction: mockBuildUpgradeTransaction,
      },
      account: {
        address: () => ({
          to_string: () => DEVNODE_ACCOUNT_0,
        }),
      },
    });
  });

  afterEach(() => {
    fixture?.cleanup();
    delete process.env["LIONDEN_PROVE"];
    vi.restoreAllMocks();
  });

  /**
   * Create a temp project with an @admin-annotated program, pre-written
   * deployment state (DeploymentRecord + ABI snapshot) on disk, and a custom
   * compile task that refreshes in-memory artifacts.
   *
   * Also injects a DeploymentManagerImpl onto lre.deployments.
   */
  async function createUpgradeFixture(opts?: {
    constructorType?: "admin" | "noupgrade" | "checksum" | "custom";
    /** Old ABI mappings to write to disk */
    oldMappings?: string[];
    /** New ABI mappings that compile produces */
    newMappings?: string[];
    /** New ABI records that compile produces */
    newRecords?: ProgramABI["records"];
    /** Skip writing old ABI snapshot */
    skipOldAbi?: boolean;
    /** Skip writing deployment record */
    skipRecord?: boolean;
    /** Edition to write in record */
    edition?: number;
    /** Constructor annotation for Leo source */
    sourceAnnotation?: string;
    /** Compiled Aleo source that compile produces for the new version */
    newAleoSource?: string;
    /** Fingerprint to store in deployment record */
    fingerprint?: string;
  }) {
    const constructorType = opts?.constructorType ?? "admin";
    const oldMappings = opts?.oldMappings ?? ["counters"];
    const newMappings = opts?.newMappings ?? ["counters"];
    const edition = opts?.edition ?? 0;

    const annotation =
      opts?.sourceAnnotation ??
      (constructorType === "admin"
        ? `@admin(address="${DEVNODE_ACCOUNT_0}")\n    constructor() {}`
        : constructorType === "noupgrade"
          ? "@noupgrade\n    constructor() {}"
          : constructorType === "checksum"
            ? '@checksum(mapping="gov.aleo::checksums", key="hello")\n    constructor() {}'
            : "@custom\n    constructor() {}");

    const oldAbi = makeAbi({ mappings: oldMappings });
    const newAbi = makeAbi({ mappings: newMappings, records: opts?.newRecords });
    const defaultAleoSource = `program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`;
    const aleoSource = opts?.newAleoSource ?? defaultAleoSource;

    // Track compile calls
    let compileCalled = false;
    let compileArgs: Record<string, unknown> | undefined;

    // Custom compile task that mutates lre.artifacts
    const compilePlugin: LionDenPlugin = {
      id: "test-compile",
      tasks: [
        task("compile", "Test compile")
          .setAction(async (args, lre) => {
            compileCalled = true;
            compileArgs = args;
            lre.artifacts.setAbi("hello.aleo", newAbi);
            lre.artifacts.setAleoSource("hello.aleo", aleoSource);
          })
          .build(),
      ],
    };

    fixture = createContractLre({
      programs: [{ name: "hello", annotation }],
      plugins: [compilePlugin],
      withNetwork: true,
      prePopulateArtifacts: [
        {
          programId: "hello.aleo",
          abi: oldAbi,
          aleoSource,
        },
      ],
    });

    const { lre, fakeNetwork, project } = fixture;
    const deploymentsDir = lre.config.paths.deployments;

    // Inject DeploymentManager onto lre.deployments
    const manager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );
    (lre as unknown as Record<string, unknown>)["deployments"] = manager;

    // Seed deployment state via the manager so both disk (non-ephemeral) and
    // in-memory cache (ephemeral) are populated.
    if (!opts?.skipRecord) {
      const fingerprint =
        opts?.fingerprint ?? extractConstructorFingerprint(defaultAleoSource, constructorType);

      const record = makeRecord({ constructorType, edition, fingerprint });
      if (constructorType === "checksum") {
        // Override checksum record
        (record as any).constructor = {
          type: "checksum",
          checksumMapping: "gov.aleo::checksums",
          checksumKey: "hello",
          fingerprint,
        };
      }
      if (opts?.skipOldAbi) {
        // Seed record directly into cache, bypassing record() ABI enforcement
        (manager as any).networkCache("devnode").set("hello.aleo", record);
      } else {
        await manager.record(record, "deploy", { abi: oldAbi });
      }
    } else if (!opts?.skipOldAbi) {
      // No record but ABI needed — write directly to disk (non-ephemeral fallback test)
      writeAbiSnapshot(deploymentsDir, "devnode", "hello.aleo", oldAbi);
    }

    // Seed getProgramSource so devnode validation sees the program as on-chain.
    // When skipRecord=true (testing "not deployed" scenario), leave getProgramSource returning null.
    if (!opts?.skipRecord) {
      fakeNetwork!.setProgramSource(
        "hello.aleo",
        `program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`,
      );
    }

    return {
      lre,
      fakeNetwork: fakeNetwork!,
      manager,
      deploymentsDir,
      getCompileCalled: () => compileCalled,
      getCompileArgs: () => compileArgs,
    };
  }

  it("upgrades a program with @admin constructor through the full action path", async () => {
    const { lre, fakeNetwork, manager, getCompileCalled, getCompileArgs } =
      await createUpgradeFixture({ constructorType: "admin" });

    const result = await upgradeAction({ program: "hello" }, lre);

    expect(result.programId).toBe("hello.aleo");
    expect(result.txId).toBeDefined();
    expect(result.newEdition).toBe(1);

    // Compile was called with { program: "hello" }
    expect(getCompileCalled()).toBe(true);
    expect(getCompileArgs()!["program"]).toBe("hello");

    expect(mockBuildDevnodeUpgradeTransaction).toHaveBeenCalledWith({
      program: expect.stringContaining("program hello.aleo"),
      priorityFee: 0,
      privateFee: false,
    });
    expect(mockBuildUpgradeTransaction).not.toHaveBeenCalled();

    // broadcastTransaction received the devnode fast-path upgrade tx bytes
    const broadcastCalls = fakeNetwork.getCallsTo("broadcastTransaction");
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0]!.args[0]).toBe("devnode-upgrade-tx-bytes");

    // Confirmation was awaited
    const confirmCalls = fakeNetwork.getCallsTo("waitForConfirmation");
    expect(confirmCalls).toHaveLength(1);

    // Deployment state updated with new edition
    const updatedRecord = manager.getCached("hello.aleo", "devnode");
    expect(updatedRecord).not.toBeNull();
    expect(updatedRecord?.edition).toBe(1);
    expect(updatedRecord?.status).toBe("complete");
    if (updatedRecord?.status === "complete") {
      expect(updatedRecord.txId).toBe(result.txId);
    }
  });

  it("uses the standard upgrade builder on devnode when prove is requested", async () => {
    const { lre, fakeNetwork } = await createUpgradeFixture({ constructorType: "admin" });

    await upgradeAction({ program: "hello", prove: true }, lre);

    expect(mockBuildDevnodeUpgradeTransaction).not.toHaveBeenCalled();
    expect(mockBuildUpgradeTransaction).toHaveBeenCalledWith({
      program: expect.stringContaining("program hello.aleo"),
      priorityFee: 0,
      privateFee: false,
    });
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "standard-upgrade-tx-bytes",
    );
  });

  it("keeps record programs on the devnode fast-path when prove is not requested", async () => {
    const recordAleoSource =
      `program hello.aleo;\n` +
      `record Bid:\n` +
      `  owner as address.private;\n` +
      `function increment:\n` +
      `  input r0 as u32.private;\n` +
      `  output r0 as u32.private;\n`;
    const { lre, fakeNetwork } = await createUpgradeFixture({
      constructorType: "admin",
      newAleoSource: recordAleoSource,
      newRecords: [{ path: ["Bid"], fields: [] }],
    });

    await upgradeAction({ program: "hello" }, lre);

    expect(mockBuildDevnodeUpgradeTransaction).toHaveBeenCalledWith({
      program: expect.stringContaining("record Bid:"),
      priorityFee: 0,
      privateFee: false,
    });
    expect(mockBuildUpgradeTransaction).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "devnode-upgrade-tx-bytes",
    );
  });

  it("uses LIONDEN_PROVE to select the standard upgrade builder", async () => {
    process.env["LIONDEN_PROVE"] = "true";
    const { lre, fakeNetwork } = await createUpgradeFixture({ constructorType: "admin" });

    await upgradeAction({ program: "hello" }, lre);

    expect(mockBuildDevnodeUpgradeTransaction).not.toHaveBeenCalled();
    expect(mockBuildUpgradeTransaction).toHaveBeenCalledWith({
      program: expect.stringContaining("program hello.aleo"),
      priorityFee: 0,
      privateFee: false,
    });
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "standard-upgrade-tx-bytes",
    );
  });

  it("throws when proving is requested but the standard upgrade builder is unavailable", async () => {
    mockCreateSdkObjects.mockResolvedValue({
      programManager: {
        buildDevnodeUpgradeTransaction: mockBuildDevnodeUpgradeTransaction,
      },
      account: {
        address: () => ({
          to_string: () => DEVNODE_ACCOUNT_0,
        }),
      },
    });
    const { lre } = await createUpgradeFixture({ constructorType: "admin" });

    await expect(upgradeAction({ program: "hello", prove: true }, lre)).rejects.toThrow(
      /buildUpgradeTransaction/,
    );
    expect(mockBuildDevnodeUpgradeTransaction).not.toHaveBeenCalled();
  });

  it("rejects upgrade of @noupgrade program", async () => {
    const { lre } = await createUpgradeFixture({ constructorType: "noupgrade" });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow("@noupgrade");
    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(DeployError);
  });

  it("rejects upgrade when new ABI is not compatible (mapping removed)", async () => {
    const { lre } = await createUpgradeFixture({
      oldMappings: ["counters", "scores"],
      newMappings: ["counters"], // "scores" mapping removed
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      UpgradeCompatibilityError,
    );
  });

  it("throws DeployError when confirmation returns rejected status", async () => {
    const { lre, fakeNetwork } = await createUpgradeFixture();

    fakeNetwork.setConfirmBehavior("reject");

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(DeployError);
  });

  it("skips confirmation when skipConfirm is true", async () => {
    const { lre, fakeNetwork } = await createUpgradeFixture();

    await upgradeAction({ program: "hello", skipConfirm: true }, lre);

    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
  });

  it("throws when no deployment record exists", async () => {
    const { lre } = await createUpgradeFixture({ skipRecord: true });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "No deployment record found",
    );
  });

  it("throws when old ABI snapshot is missing", async () => {
    const { lre } = await createUpgradeFixture({ skipOldAbi: true });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow("No ABI found");
  });

  it("rejects upgrade when constructor type changes", async () => {
    const { lre } = await createUpgradeFixture({
      constructorType: "admin",
      sourceAnnotation: "@noupgrade\n    constructor() {}",
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "constructor type changed",
    );
  });

  it("rejects upgrade when admin address changes", async () => {
    const { lre } = await createUpgradeFixture({
      constructorType: "admin",
      sourceAnnotation:
        '@admin(address="aleo1qnr4dkkvkgfqph0vzc3y6z2eu975wnpz2925ntjccd5cfqxtyu8s7pyjh9")\n    constructor() {}',
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow("admin address changed");
  });

  it("rejects upgrade when @custom constructor body changes", async () => {
    const oldSource = [
      "program hello.aleo;",
      "function main:",
      "  input r0 as u32.private;",
      "  output r0 as u32.private;",
      "",
      "constructor:",
      "    call governance.aleo/check_vote into r0;",
      "    assert.eq r0 true;",
      "    assert.eq edition 0u16;",
      "",
    ].join("\n");

    const newSource = [
      "program hello.aleo;",
      "function main:",
      "  input r0 as u32.private;",
      "  output r0 as u32.private;",
      "",
      "constructor:",
      "    assert.eq self.caller aleo1different;",
      "    assert.eq edition 1u16;",
      "",
    ].join("\n");

    const oldFingerprint = extractConstructorFingerprint(oldSource, "custom");

    const { lre } = await createUpgradeFixture({
      constructorType: "custom",
      sourceAnnotation: "@custom\n    constructor() {}",
      newAleoSource: newSource,
      fingerprint: oldFingerprint,
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "constructor body changed",
    );
  });

  it("rejects upgrade when @checksum parameters change", async () => {
    const compilePlugin: LionDenPlugin = {
      id: "test-compile",
      tasks: [
        task("compile", "Test compile")
          .setAction(async (_args, lre) => {
            lre.artifacts.setAbi("hello.aleo", makeAbi());
            lre.artifacts.setAleoSource(
              "hello.aleo",
              "program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n",
            );
          })
          .build(),
      ],
    };

    fixture = createContractLre({
      programs: [
        {
          name: "hello",
          annotation:
            '@checksum(mapping="new_gov.aleo::checksums", key="hello")\n    constructor() {}',
        },
      ],
      plugins: [compilePlugin],
      withNetwork: true,
      prePopulateArtifacts: [
        {
          programId: "hello.aleo",
          abi: makeAbi(),
          aleoSource:
            "program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n",
        },
      ],
    });

    const { lre } = fixture;
    const manager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );
    (lre as unknown as Record<string, unknown>)["deployments"] = manager;

    // Write record with old checksum params
    const record: CompleteDeploymentRecord = {
      status: "complete",
      programId: "hello.aleo",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      txId: "at1original",
      blockHeight: 1,
      edition: 0,
      constructor: {
        type: "checksum",
        checksumMapping: "old_gov.aleo::checksums",
        checksumKey: "hello",
        fingerprint: "",
      },
      abiHash: null,
      deployerAddress: DEVNODE_ACCOUNT_0,
      deployedAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      historyCount: 1,
    };
    await manager.record(record, "deploy", { abi: makeAbi() });

    fixture.fakeNetwork!.setProgramSource(
      "hello.aleo",
      "program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n",
    );

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "@checksum parameters changed",
    );
  });

  it("increments edition in deployment record", async () => {
    const { lre, manager } = await createUpgradeFixture({ edition: 2 });

    const result = await upgradeAction({ program: "hello" }, lre);

    expect(result.newEdition).toBe(3);

    const updatedRecord = manager.getCached("hello.aleo", "devnode");
    expect(updatedRecord!.edition).toBe(3);
  });

  it("promotes a degraded record to complete after upgrade", async () => {
    // Fixture writes a complete record, but let's manually set a degraded one in cache
    const { lre, manager, deploymentsDir } = await createUpgradeFixture();

    // Override: write a degraded record
    const degraded = {
      status: "degraded" as const,
      programId: "hello.aleo",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      txId: null,
      blockHeight: null,
      deployerAddress: null,
      deployedAt: null,
      feePaid: null,
      edition: 0,
      constructor: { type: "admin" as const, adminAddress: DEVNODE_ACCOUNT_0 },
      abiHash: null,
      updatedAt: "2026-04-01T00:00:00.000Z",
      historyCount: 1,
    };
    // Directly seed the degraded record into cache — record() would skip it
    // due to the degraded guard (same edition/endpoint as the existing complete record).
    (manager as any).networkCache("devnode").set("hello.aleo", degraded);

    const result = await upgradeAction({ program: "hello" }, lre);

    // Record should be promoted to complete
    const updatedRecord = manager.getCached("hello.aleo", "devnode");
    expect(updatedRecord!.status).toBe("complete");
    expect(updatedRecord!.edition).toBe(1);
    expect(result.newEdition).toBe(1);
  });

  it("allows upgrade when new mappings are added (additive ABI change)", async () => {
    const { lre, manager } = await createUpgradeFixture({
      oldMappings: ["counters"],
      newMappings: ["counters", "scores"], // "scores" added — additive, so allowed
    });

    const result = await upgradeAction({ program: "hello" }, lre);

    // Upgrade should succeed (additive ABI changes are allowed)
    expect(result.programId).toBe("hello.aleo");
    expect(result.newEdition).toBe(1);

    // Record updated
    const updatedRecord = manager.getCached("hello.aleo", "devnode");
    expect(updatedRecord).not.toBeNull();
    expect(updatedRecord?.edition).toBe(1);

    // History is only available in non-ephemeral mode (devnode defaults to ephemeral)
    const history = await manager.getHistory("hello.aleo", "devnode");
    expect(history).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // SDK plumbing — every createSdkObjects() inside the upgrade flow must
  // carry the resolved keyCache from config and the egressPolicy from the
  // active connection. Mirrors the deploy-side assertion: keyCache
  // propagation amortizes credits-key persistence across throwaway SDK
  // objects, and egressPolicy installs the guarded network transport that
  // forces `hasCustomTransport=true` and scopes chain-state/submission
  // egress to the connection endpoint. A regression on any upgrade call
  // site (buildAndBroadcastUpgrade, resolveDeployerAddress, admin signer
  // validation) is caught here.
  // -------------------------------------------------------------------------
  describe("createSdkObjects plumbing", () => {
    it("passes keyCache and egressPolicy to every createSdkObjects call on devnode upgrade", async () => {
      const { lre, fakeNetwork } = await createUpgradeFixture({
        constructorType: "admin",
      });

      await upgradeAction({ program: "hello" }, lre);

      expect(mockCreateSdkObjects.mock.calls.length).toBeGreaterThanOrEqual(1);
      for (const call of mockCreateSdkObjects.mock.calls) {
        expect(call[0]).toMatchObject({
          network: fakeNetwork.networkId,
          endpoint: fakeNetwork.endpoint,
          egressPolicy: fakeNetwork.egressPolicy,
        });
      }
      // buildAndBroadcastUpgrade is the helper that should carry keyCache.
      // It's the call with apiKey present; admin-signer / resolveDeployerAddress
      // skip apiKey/keyCache.
      const helperCalls = mockCreateSdkObjects.mock.calls.filter(
        (c) => "apiKey" in (c[0] ?? {}) && "keyCache" in (c[0] ?? {}),
      );
      expect(helperCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of helperCalls) {
        expect(call[0]).toMatchObject({
          keyCache: lre.config.sdk.keyCache,
        });
      }
    });

    it("propagates the egressPolicy when LIONDEN_PROVE forces the standard upgrade builder", async () => {
      process.env["LIONDEN_PROVE"] = "true";
      const { lre, fakeNetwork } = await createUpgradeFixture({
        constructorType: "admin",
      });

      await upgradeAction({ program: "hello" }, lre);

      for (const call of mockCreateSdkObjects.mock.calls) {
        expect(call[0]).toMatchObject({
          egressPolicy: fakeNetwork.egressPolicy,
        });
      }
    });
  });
});
