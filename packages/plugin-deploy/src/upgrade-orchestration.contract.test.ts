import type { LionDenPlugin } from "@lionden/core";
import { task } from "@lionden/core";
import type { ProgramABI } from "@lionden/leo-compiler";
import type { NetworkManager } from "@lionden/network";
import { SdkDiagnostics } from "@lionden/network";
import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentManagerImpl } from "./deployment-manager.js";
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
function makeAbi(): ProgramABI {
  return {
    program: "hello.aleo",
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
function makeRecord(opts?: { network?: string; endpoint?: string }): CompleteDeploymentRecord {
  return {
    status: "complete",
    programId: "hello.aleo",
    network: opts?.network ?? "devnode",
    endpoint: opts?.endpoint ?? "http://127.0.0.1:3030",
    txId: "at1original",
    blockHeight: 1,
    deployerAddress: DEVNODE_ACCOUNT_0,
    deployedAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
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
    /** Compiled Aleo source that compile produces for the new version. */
    newAleoSource?: string;
  }) {
    const aleoSource = opts?.newAleoSource ?? PROGRAM_SOURCE;
    const newAbi = makeAbi();

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
      programs: [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      plugins: [compilePlugin],
      withNetwork: true,
      prePopulateArtifacts: [{ programId: "hello.aleo", abi: newAbi, aleoSource }],
    });

    const { lre, fakeNetwork } = fixture;

    // Inject DeploymentManager onto lre.deployments
    const manager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );
    (lre as unknown as Record<string, unknown>)["deployments"] = manager;

    if (!opts?.skipRecord) {
      await manager.record(makeRecord(), "deploy", { abi: makeAbi() });
      // Seed getProgramSource so devnode validation sees the program as on-chain.
      fakeNetwork!.setProgramSource("hello.aleo", PROGRAM_SOURCE);
    }

    return {
      lre,
      fakeNetwork: fakeNetwork!,
      manager,
      getCompileCalled: () => compileCalled,
      getCompileArgs: () => compileArgs,
    };
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
    }
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
    await manager.record(makeRecord({ network: "testnet" }), "deploy", { abi: makeAbi() });
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
    await manager.record(makeRecord({ network: "testnet" }), "deploy", { abi: makeAbi() });
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
