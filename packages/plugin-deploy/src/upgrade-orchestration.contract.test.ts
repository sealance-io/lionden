import type { LionDenPlugin } from "@lionden/core";
import {
  KEY_ARTIFACTS_FORMAT,
  keyArtifactsMetadataPath,
  sha256Json,
  sha256Text,
  task,
  writeKeyArtifactsMetadata,
} from "@lionden/core";
import type { ProgramABI } from "@lionden/leo-compiler";
import type { NetworkManager } from "@lionden/network";
import { SdkDiagnostics } from "@lionden/network";
import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentManagerImpl } from "./deployment-manager.js";
import { readPendingMarker } from "./deployment-state.js";
import type { CompleteDeploymentRecord } from "./deployment-types.js";
import { DeployError } from "./errors.js";
import { upgradeAction } from "./upgrade-task.js";

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
function makeAbi(programId = "hello.aleo"): ProgramABI {
  return {
    program: programId,
    transitions: [{ name: "increment", inputs: [], outputs: [], is_async: false }],
    structs: [],
    records: [],
    mappings: [
      {
        name: "counters",
        key: { Primitive: "Address" } as const,
        value: { Primitive: { UInt: "U64" } } as const,
      },
    ],
    storage_variables: [],
  };
}

/** Build a complete deployment record for testing. */
function makeRecord(opts?: {
  network?: string;
  endpoint?: string;
  programId?: string;
  sourceProgramId?: string;
}): CompleteDeploymentRecord {
  return {
    status: "complete",
    programId: opts?.programId ?? "hello.aleo",
    ...(opts?.sourceProgramId === undefined ? {} : { sourceProgramId: opts.sourceProgramId }),
    network: opts?.network ?? "devnode",
    endpoint: opts?.endpoint ?? "http://127.0.0.1:3030",
    txId: "at1original",
    blockHeight: 1,
    deployerAddress: DEVNODE_ACCOUNT_0,
    deployedAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    edition: 1,
    historyCount: 1,
  };
}

const PROGRAM_SOURCE = `program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`;

describe("upgrade orchestration contract (thin)", () => {
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
      diagnostics: new SdkDiagnostics(),
    });
  });

  afterEach(() => {
    fixture?.cleanup();
    delete process.env["LIONDEN_PROVE"];
    vi.restoreAllMocks();
  });

  /**
   * Create a temp project with a @noupgrade-annotated program, a pre-written
   * complete deployment record, and a custom compile task that refreshes the
   * in-memory artifacts (the v2 ABI + .aleo source).
   *
   * Also injects a DeploymentManagerImpl onto lre.deployments.
   */
  async function createUpgradeFixture(opts?: {
    /** Skip writing the prior deployment record (and leave the program off-chain). */
    skipRecord?: boolean;
    /** Keep deployment state on disk so pending markers can be recovered. */
    diskBacked?: boolean;
    /** Runtime deployment record id and upgrade target. */
    runtimeProgramId?: string;
    /** Local source program id for renamed deployments. */
    sourceProgramId?: string;
    /** Artifact id populated by the compile task. */
    compiledOutputProgramId?: string;
    /** Compiled Aleo source that compile produces for the new version. */
    newAleoSource?: string;
  }) {
    const runtimeProgramId = opts?.runtimeProgramId ?? "hello.aleo";
    const sourceProgramId = opts?.sourceProgramId;
    const compiledOutputProgramId = opts?.compiledOutputProgramId ?? runtimeProgramId;
    const aleoSource =
      opts?.newAleoSource ??
      `program ${compiledOutputProgramId};\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`;
    const newAbi = makeAbi(compiledOutputProgramId);

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
            lre.artifacts.setAbi(compiledOutputProgramId, newAbi);
            lre.artifacts.setAleoSource(compiledOutputProgramId, aleoSource);
          })
          .build(),
      ],
    };

    fixture = createContractLre({
      programs: [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      plugins: [compilePlugin],
      withNetwork: true,
      prePopulateArtifacts: [{ programId: compiledOutputProgramId, abi: newAbi, aleoSource }],
    });

    const { lre, fakeNetwork } = fixture;
    if (sourceProgramId && sourceProgramId !== runtimeProgramId) {
      (lre.config as unknown as { leoVersion: string }).leoVersion = "4.3.2";
    }
    if (opts?.diskBacked) {
      (lre.config.networks.devnode as { ephemeral?: boolean }).ephemeral = false;
    }
    const broadcastTransaction = fakeNetwork!.broadcastTransaction.bind(fakeNetwork!);
    vi.spyOn(fakeNetwork!, "broadcastTransaction").mockImplementation(async (transaction) => {
      const txId = await broadcastTransaction(transaction);
      fakeNetwork!.setProgramSource(runtimeProgramId, aleoSource);
      fakeNetwork!.setProgramEdition(runtimeProgramId, 2);
      return txId;
    });

    // Inject DeploymentManager onto lre.deployments
    const manager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );
    (lre as unknown as Record<string, unknown>)["deployments"] = manager;

    if (!opts?.skipRecord) {
      await manager.record(makeRecord({ programId: runtimeProgramId, sourceProgramId }), "deploy", {
        abi: makeAbi(compiledOutputProgramId),
      });
      // Seed getProgramSource so devnode validation sees the program as on-chain.
      fakeNetwork!.setProgramSource(runtimeProgramId, PROGRAM_SOURCE);
      fakeNetwork!.setProgramEdition(runtimeProgramId, 1);
    }

    return {
      lre,
      fakeNetwork: fakeNetwork!,
      manager,
      artifactsDir: fixture.project.artifactsDir,
      getCompileCalled: () => compileCalled,
      getCompileArgs: () => compileArgs,
    };
  }

  function writeArtifactProvenance(
    artifactsDir: string,
    programId: string,
    sourceProgramId: string,
    metadataProgramId = programId,
  ): void {
    writeKeyArtifactsMetadata(keyArtifactsMetadataPath(artifactsDir, programId), {
      format: KEY_ARTIFACTS_FORMAT,
      programId: metadataProgramId,
      sourceProgramId,
      sourceHash: sha256Text(`program ${metadataProgramId};\n`),
      importsHash: sha256Json({ imports: [] }),
    });
  }

  it("upgrades a program through the full action path (compile → build → broadcast → record)", async () => {
    const { lre, fakeNetwork, manager, getCompileCalled, getCompileArgs } =
      await createUpgradeFixture();

    const result = await upgradeAction({ program: "hello" }, lre);

    expect(result.programId).toBe("hello.aleo");
    expect(result.txId).toBeDefined();
    expect(result).not.toHaveProperty("newEdition");

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

    // Deployment state updated (still a complete record)
    const updatedRecord = manager.getCached("hello.aleo", "devnode");
    expect(updatedRecord).not.toBeNull();
    expect(updatedRecord?.status).toBe("complete");
    if (updatedRecord?.status === "complete") {
      expect(updatedRecord.txId).toBe(result.txId);
      expect(updatedRecord.edition).toBe(2);
    }
  });

  it("upgrades a renamed deployment by compiling the source id and recording the runtime id", async () => {
    const { lre, manager, getCompileArgs } = await createUpgradeFixture({
      runtimeProgramId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      compiledOutputProgramId: "tenant.aleo",
    });

    const result = await upgradeAction({ program: "tenant" }, lre);

    expect(result.programId).toBe("tenant.aleo");
    expect(getCompileArgs()).toEqual({
      program: "hello.aleo",
      rename: "tenant.aleo",
    });
    expect(mockBuildDevnodeUpgradeTransaction).toHaveBeenCalledWith({
      program: expect.stringContaining("program tenant.aleo"),
      priorityFee: 0,
      privateFee: false,
    });

    const updatedRecord = manager.getCached("tenant.aleo", "devnode");
    expect(updatedRecord?.status).toBe("complete");
    if (updatedRecord?.status === "complete") {
      expect(updatedRecord.programId).toBe("tenant.aleo");
      expect(updatedRecord.sourceProgramId).toBe("hello.aleo");
      expect(updatedRecord.txId).toBe(result.txId);
    }
  });

  it("reconstructs renamed upgrade provenance from runtime artifacts when local deployment state is missing", async () => {
    const { lre, fakeNetwork, manager, artifactsDir, getCompileArgs } = await createUpgradeFixture({
      skipRecord: true,
      runtimeProgramId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      compiledOutputProgramId: "tenant.aleo",
    });
    fakeNetwork.setProgramSource(
      "tenant.aleo",
      PROGRAM_SOURCE.replace("hello.aleo", "tenant.aleo"),
    );
    fakeNetwork.setProgramEdition("tenant.aleo", 1);
    writeArtifactProvenance(artifactsDir, "tenant.aleo", "hello.aleo");

    expect(await manager.getDeployment("tenant.aleo", "devnode")).toBeNull();

    const result = await upgradeAction({ program: "tenant" }, lre);

    expect(result.programId).toBe("tenant.aleo");
    expect(getCompileArgs()).toEqual({
      program: "hello.aleo",
      rename: "tenant.aleo",
    });

    const updatedRecord = manager.getCached("tenant.aleo", "devnode");
    expect(updatedRecord?.status).toBe("complete");
    if (updatedRecord?.status === "complete") {
      expect(updatedRecord.programId).toBe("tenant.aleo");
      expect(updatedRecord.sourceProgramId).toBe("hello.aleo");
      expect(updatedRecord.txId).toBe(result.txId);
    }
  });

  it("rejects renamed upgrade provenance that does not match the runtime target", async () => {
    const { lre, fakeNetwork, artifactsDir, getCompileCalled } = await createUpgradeFixture({
      skipRecord: true,
      runtimeProgramId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      compiledOutputProgramId: "tenant.aleo",
    });
    fakeNetwork.setProgramSource(
      "tenant.aleo",
      PROGRAM_SOURCE.replace("hello.aleo", "tenant.aleo"),
    );
    fakeNetwork.setProgramEdition("tenant.aleo", 1);
    writeArtifactProvenance(artifactsDir, "tenant.aleo", "hello.aleo", "other.aleo");

    try {
      await upgradeAction({ program: "tenant" }, lre);
      throw new Error("Expected upgradeAction to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(DeployError);
      expect(err).toHaveProperty(
        "message",
        expect.stringMatching(
          /Artifact provenance metadata is invalid for upgrade target "tenant\.aleo"/,
        ),
      );
    }

    expect(getCompileCalled()).toBe(false);
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("rejects renamed upgrades before compile when Leo does not support rename", async () => {
    const { lre, getCompileCalled } = await createUpgradeFixture({
      runtimeProgramId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      compiledOutputProgramId: "tenant.aleo",
    });
    (lre.config as unknown as { leoVersion: string }).leoVersion = "4.2.9";

    await expect(upgradeAction({ program: "tenant" }, lre)).rejects.toThrow(/requires Leo 4\.3\.0/);

    expect(getCompileCalled()).toBe(false);
  });

  it("rejects renamed upgrades before compile when compiler.buildTests is enabled", async () => {
    const { lre, fakeNetwork, getCompileCalled } = await createUpgradeFixture({
      runtimeProgramId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      compiledOutputProgramId: "tenant.aleo",
    });
    (lre.config.compiler as { buildTests: boolean }).buildTests = true;

    await expect(upgradeAction({ program: "tenant" }, lre)).rejects.toThrow(
      /compiler\.buildTests is enabled/,
    );

    expect(getCompileCalled()).toBe(false);
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("preserves sourceProgramId in the pending marker for renamed upgrades", async () => {
    const { lre } = await createUpgradeFixture({
      diskBacked: true,
      runtimeProgramId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      compiledOutputProgramId: "tenant.aleo",
    });
    mockBuildDevnodeUpgradeTransaction.mockRejectedValueOnce(new Error("builder failed"));

    await expect(upgradeAction({ program: "tenant" }, lre)).rejects.toThrow("builder failed");

    expect(readPendingMarker(lre.config.paths.deployments, "devnode", "tenant.aleo")).toMatchObject(
      {
        programId: "tenant.aleo",
        sourceProgramId: "hello.aleo",
        action: "upgrade",
      },
    );
  });

  it("keeps sourceProgramId when recovering a renamed upgrade", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture({
      diskBacked: true,
      runtimeProgramId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      compiledOutputProgramId: "tenant.aleo",
    });
    await manager.setPending({
      programId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      action: "upgrade",
      txId: "at1renamed",
      blockHeight: 2,
      previousEdition: 1,
      startedAt: "2026-04-01T00:01:00.000Z",
      deployerAddress: DEVNODE_ACCOUNT_0,
      priorityFee: 0,
      privateFee: false,
      network: "devnode",
      endpoint: fakeNetwork.endpoint,
    });
    fakeNetwork.setProgramSource("tenant.aleo", "program tenant.aleo;");
    fakeNetwork.setProgramEdition("tenant.aleo", 2);

    const recoveringManager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );

    const recovered = await recoveringManager.recoverPendingDeployments("devnode", fakeNetwork);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: "recovered",
      programId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
      edition: 2,
      txId: "at1renamed",
      blockHeight: 2,
      historyCount: 2,
    });
    const latest = await recoveringManager.getDeployment("tenant.aleo", "devnode");
    expect(latest?.sourceProgramId).toBe("hello.aleo");
  });

  it("selects the signing key from namedAccounts.admin (selection only)", async () => {
    const { lre } = await createUpgradeFixture();
    (lre.namedAccounts as Record<string, unknown>)["admin"] = {
      type: "signable",
      name: "admin",
      address: DEVNODE_ACCOUNT_0,
      privateKey: "admin-private-key",
    };

    await upgradeAction({ program: "hello" }, lre);

    // The upgrade builder (the createSdkObjects call carrying apiKey + keyCache)
    // must sign with the admin key.
    const helperCalls = mockCreateSdkObjects.mock.calls.filter(
      (c) => "apiKey" in (c[0] ?? {}) && "keyCache" in (c[0] ?? {}),
    );
    expect(helperCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of helperCalls) {
      expect(call[0]).toMatchObject({ privateKey: "admin-private-key" });
    }
  });

  it("honors a programmatic network override", async () => {
    const { lre, fakeNetwork } = await createUpgradeFixture();
    (lre.config.networks as Record<string, unknown>)["testnet"] = {
      ...lre.config.networks.devnode,
    };
    const manager = lre.deployments as DeploymentManagerImpl;
    await manager.record(makeRecord({ network: "testnet" }), "deploy", {
      abi: makeAbi(),
    });
    const connect = vi
      .spyOn(lre.network as NetworkManager, "connect")
      .mockResolvedValue(fakeNetwork);

    await upgradeAction({ program: "hello", network: "testnet" }, lre);

    expect(connect).toHaveBeenCalledWith("testnet");
  });

  it("forwards an explicit network into the implicit compile", async () => {
    const { lre, fakeNetwork, getCompileArgs } = await createUpgradeFixture();
    (lre.config.networks as Record<string, unknown>)["testnet"] = {
      ...lre.config.networks.devnode,
    };
    const manager = lre.deployments as DeploymentManagerImpl;
    await manager.record(makeRecord({ network: "testnet" }), "deploy", {
      abi: makeAbi(),
    });
    vi.spyOn(lre.network as NetworkManager, "connect").mockResolvedValue(fakeNetwork);

    await upgradeAction({ program: "hello", network: "testnet" }, lre);

    // The implicit compile must resolve network deps + `.env` for the deploying
    // network — so the explicit network rides along with the program arg.
    expect(getCompileArgs()).toEqual({ program: "hello", network: "testnet" });
  });

  it("omits network from the implicit compile on a default-network run", async () => {
    const { lre, getCompileArgs } = await createUpgradeFixture();

    await upgradeAction({ program: "hello" }, lre);

    // No explicit network → compile gets only the program; it falls back to
    // config.defaultNetwork exactly as before.
    expect(getCompileArgs()).toEqual({ program: "hello" });
    expect(getCompileArgs()).not.toHaveProperty("network");
  });

  it("uses the standard upgrade builder on devnode when prove is requested", async () => {
    const { lre, fakeNetwork } = await createUpgradeFixture();

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

  it("uses LIONDEN_PROVE to select the standard upgrade builder", async () => {
    process.env["LIONDEN_PROVE"] = "true";
    const { lre, fakeNetwork } = await createUpgradeFixture();

    await upgradeAction({ program: "hello" }, lre);

    expect(mockBuildDevnodeUpgradeTransaction).not.toHaveBeenCalled();
    expect(mockBuildUpgradeTransaction).toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "standard-upgrade-tx-bytes",
    );
  });

  it("uses lre.globalOptions.prove (the --prove global option) to select the standard upgrade builder", async () => {
    const { lre, fakeNetwork } = await createUpgradeFixture();
    lre.globalOptions["prove"] = true;

    await upgradeAction({ program: "hello" }, lre);

    expect(mockBuildDevnodeUpgradeTransaction).not.toHaveBeenCalled();
    expect(mockBuildUpgradeTransaction).toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "standard-upgrade-tx-bytes",
    );
  });

  it("lets an explicit --prove=false global override LIONDEN_PROVE (stays on the devnode fast-path)", async () => {
    process.env["LIONDEN_PROVE"] = "true";
    const { lre, fakeNetwork } = await createUpgradeFixture();
    lre.globalOptions["prove"] = false;

    await upgradeAction({ program: "hello" }, lre);

    expect(mockBuildDevnodeUpgradeTransaction).toHaveBeenCalled();
    expect(mockBuildUpgradeTransaction).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "devnode-upgrade-tx-bytes",
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
      diagnostics: new SdkDiagnostics(),
    });
    const { lre } = await createUpgradeFixture();

    await expect(upgradeAction({ program: "hello", prove: true }, lre)).rejects.toThrow(
      /buildUpgradeTransaction/,
    );
    expect(mockBuildDevnodeUpgradeTransaction).not.toHaveBeenCalled();
  });

  it("clears pending marker when confirmation returns rejected status", async () => {
    const { lre, fakeNetwork } = await createUpgradeFixture({
      diskBacked: true,
    });

    fakeNetwork.setConfirmBehavior("reject");

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(DeployError);
    expect(readPendingMarker(lre.config.paths.deployments, "devnode", "hello.aleo")).toBeNull();
  });

  it("skips confirmation when skipConfirm is true", async () => {
    const { lre, fakeNetwork } = await createUpgradeFixture();

    await upgradeAction({ program: "hello", skipConfirm: true }, lre);

    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
  });

  it("waits for on-chain edition to advance after confirmation", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture();
    vi.spyOn(fakeNetwork, "getProgramEdition")
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);

    await upgradeAction({ program: "hello" }, lre);

    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    if (record?.status === "complete") {
      expect(record.edition).toBe(2);
    }
  });

  it("fails instead of writing an upgraded record when edition never advances after confirmation", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture();
    (lre.config.deploy as any).confirmationTimeout = 5;
    vi.spyOn(fakeNetwork, "getProgramEdition")
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(null);

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow("Timed out waiting");

    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    if (record?.status === "complete") {
      expect(record.txId).toBe("at1original");
      expect(record.edition).toBe(1);
    }
  });

  it("does not write a pending marker when the pre-broadcast edition baseline cannot be read", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture({
      diskBacked: true,
    });
    vi.spyOn(fakeNetwork, "getProgramEdition").mockResolvedValue(null);

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "read current edition before upgrade",
    );

    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
    expect(readPendingMarker(lre.config.paths.deployments, "devnode", "hello.aleo")).toBeNull();
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    expect(record?.edition).toBe(1);
  });

  it("recovers confirmed upgrade provenance after edition advance polling times out", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture({
      diskBacked: true,
    });
    (lre.config.deploy as { confirmationTimeout: number }).confirmationTimeout = 5;
    const editionSpy = vi
      .spyOn(fakeNetwork, "getProgramEdition")
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(null);

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow("Timed out waiting");

    const originalRecord = manager.getCached("hello.aleo", "devnode");
    expect(originalRecord?.status).toBe("complete");
    if (originalRecord?.status === "complete") {
      expect(originalRecord.txId).toBe("at1original");
      expect(originalRecord.edition).toBe(1);
      expect(originalRecord.historyCount).toBe(1);
    }

    editionSpy.mockResolvedValue(2);
    const recoveringManager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );

    const recovered = await recoveringManager.recoverPendingDeployments("devnode", fakeNetwork);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: "recovered",
      programId: "hello.aleo",
      edition: 2,
      txId: expect.stringMatching(/^at1fake/),
      blockHeight: 2,
      historyCount: 2,
    });
    const latest = await recoveringManager.getDeployment("hello.aleo", "devnode");
    expect(latest?.status).toBe("recovered");
    expect(latest?.historyCount).toBe(2);
    expect(await recoveringManager.getHistory("hello.aleo", "devnode")).toHaveLength(2);
  });

  it("records previousEdition + 1 when skipConfirm is true", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture();
    vi.spyOn(fakeNetwork, "getProgramEdition").mockResolvedValue(1);

    await upgradeAction({ program: "hello", skipConfirm: true }, lre);

    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    if (record?.status === "complete") {
      expect(record.edition).toBe(2);
    }
  });

  it("falls back to tracked local edition for skip-confirm when live baseline is unavailable", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture();
    vi.spyOn(fakeNetwork, "getProgramEdition").mockResolvedValue(null);

    await upgradeAction({ program: "hello", skipConfirm: true }, lre);

    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    if (record?.status === "complete") {
      expect(record.edition).toBe(2);
    }
  });

  it("skips auto-export when skip-confirm is true", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture();
    (lre.config.deploy as { autoExport: boolean }).autoExport = true;
    vi.spyOn(fakeNetwork, "getProgramEdition").mockResolvedValue(1);
    const exportSpy = vi.spyOn(manager, "export");

    await upgradeAction({ program: "hello", skipConfirm: true }, lre);

    expect(exportSpy).not.toHaveBeenCalled();
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    expect(record?.edition).toBe(2);
  });

  it("auto-exports after a confirmed upgrade", async () => {
    const { lre, manager } = await createUpgradeFixture();
    (lre.config.deploy as { autoExport: boolean }).autoExport = true;
    const exportSpy = vi.spyOn(manager, "export");

    await upgradeAction({ program: "hello" }, lre);

    expect(exportSpy).toHaveBeenCalledWith("devnode");
  });

  it("uses live on-chain edition as upgrade baseline instead of local record edition", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture();
    await manager.record({ ...makeRecord(), edition: 7, historyCount: 2 }, "deploy", {
      abi: makeAbi(),
    });
    vi.spyOn(fakeNetwork, "getProgramEdition")
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);

    await upgradeAction({ program: "hello" }, lre);

    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    if (record?.status === "complete") {
      expect(record.edition).toBe(2);
    }
  });

  it("reuses the observed fallback edition as the upgrade baseline", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture({
      skipRecord: true,
    });
    (lre.config.networks as Record<string, unknown>)["testnet"] = {
      type: "http",
      endpoint: fakeNetwork.endpoint,
      network: fakeNetwork.networkId,
    };
    vi.spyOn(lre.network as NetworkManager, "connect").mockResolvedValue(fakeNetwork);
    fakeNetwork.setProgramSource("hello.aleo", PROGRAM_SOURCE);
    fakeNetwork.setProgramEdition("hello.aleo", 1);
    vi.spyOn(fakeNetwork, "getProgramEdition")
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(2);

    expect(await manager.getDeployment("hello.aleo", "testnet")).toBeNull();

    const result = await upgradeAction({ program: "hello", network: "testnet" }, lre);

    expect(result.programId).toBe("hello.aleo");
    const updatedRecord = manager.getCached("hello.aleo", "testnet");
    expect(updatedRecord).not.toBeNull();
    expect(updatedRecord?.status).toBe("complete");
    if (updatedRecord?.status === "complete") {
      expect(updatedRecord.txId).toBe(result.txId);
      expect(updatedRecord.edition).toBe(2);
    }
  });

  it("throws on HTTP when no deployment record exists and the program is absent on-chain", async () => {
    const { lre, fakeNetwork, manager } = await createUpgradeFixture({
      skipRecord: true,
    });
    (lre.config.networks as Record<string, unknown>)["testnet"] = {
      type: "http",
      endpoint: fakeNetwork.endpoint,
      network: fakeNetwork.networkId,
    };
    vi.spyOn(lre.network as NetworkManager, "connect").mockResolvedValue(fakeNetwork);

    expect(await manager.getDeployment("hello.aleo", "testnet")).toBeNull();
    expect(await fakeNetwork.getProgramSource("hello.aleo")).toBeNull();

    await expect(upgradeAction({ program: "hello", network: "testnet" }, lre)).rejects.toThrow(
      "No deployment record found",
    );
  });

  it("promotes a degraded record to complete after upgrade", async () => {
    const { lre, manager } = await createUpgradeFixture();

    // Seed a degraded record directly into cache (record() would skip it via the
    // degraded guard since the existing complete record shares the endpoint).
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
      updatedAt: "2026-04-01T00:00:00.000Z",
      edition: 1,
      historyCount: 1,
    };
    (manager as any).networkCache("devnode").set("hello.aleo", degraded);

    const result = await upgradeAction({ program: "hello" }, lre);

    const updatedRecord = manager.getCached("hello.aleo", "devnode");
    expect(updatedRecord!.status).toBe("complete");
    if (updatedRecord?.status === "complete") {
      expect(updatedRecord.txId).toBe(result.txId);
    }
  });

  // -------------------------------------------------------------------------
  // SDK plumbing — every createSdkObjects() inside the upgrade flow must
  // carry the resolved keyCache from config and the egressPolicy from the
  // active connection.
  // -------------------------------------------------------------------------
  describe("createSdkObjects plumbing", () => {
    it("passes keyCache and egressPolicy to every createSdkObjects call on devnode upgrade", async () => {
      const { lre, fakeNetwork } = await createUpgradeFixture();

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
      // It's the call with apiKey present; resolveDeployerAddress skips apiKey/keyCache.
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
      const { lre, fakeNetwork } = await createUpgradeFixture();

      await upgradeAction({ program: "hello" }, lre);

      for (const call of mockCreateSdkObjects.mock.calls) {
        expect(call[0]).toMatchObject({
          egressPolicy: fakeNetwork.egressPolicy,
        });
      }
    });
  });
});
