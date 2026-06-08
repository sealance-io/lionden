/**
 * Tier 2 contract test — crosses: @lionden/plugin-deploy + @lionden/leo-compiler + @lionden/network
 *
 * Tests the full deploy orchestration: deployAction() calls real discoverUnits()
 * and resolveDependencies() from leo-compiler, resolves deploy targets, parses
 * constructors from Leo source, and broadcasts through a mocked NetworkConnection.
 */

import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployError, type DeployTaskResult, deployAction } from "./deploy-task.js";

const mockCreateSdkObjects = vi.hoisted(() => vi.fn());
const mockBuildDevnodeDeploymentTransaction = vi.hoisted(() => vi.fn());
const mockBuildDeploymentTransaction = vi.hoisted(() => vi.fn());
const mockDeploy = vi.hoisted(() => vi.fn());

// Mock @lionden/network's SDK layer to avoid real SDK instantiation.
// deployAction → deployToNetwork → import("@lionden/network")
vi.mock("@lionden/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/network")>();
  return {
    ...original,
    createSdkObjects: mockCreateSdkObjects,
    checkDevnodeSdkSupport: vi.fn().mockResolvedValue(undefined),
    initConsensusHeights: vi.fn().mockResolvedValue(undefined),
  };
});

/** Unwrap a DeployTaskResult as a deploy-mode result array. */
function unwrapDeploy(result: DeployTaskResult) {
  if (result.mode !== "deploy") {
    throw new Error(`Expected deploy mode, got: ${result.mode}`);
  }
  return result.results;
}

describe("deploy orchestration contract", () => {
  let fixture: ContractLreResult;

  beforeEach(() => {
    delete process.env["LIONDEN_PROVE"];
    mockCreateSdkObjects.mockReset();
    mockBuildDevnodeDeploymentTransaction.mockReset();
    mockBuildDeploymentTransaction.mockReset();
    mockDeploy.mockReset();

    mockBuildDevnodeDeploymentTransaction.mockResolvedValue("mock-tx-bytes");
    mockBuildDeploymentTransaction.mockResolvedValue("standard-deploy-tx-bytes");
    mockDeploy.mockResolvedValue("at1deploy");
    mockCreateSdkObjects.mockResolvedValue({
      programManager: {
        buildDevnodeDeploymentTransaction: mockBuildDevnodeDeploymentTransaction,
        buildDeploymentTransaction: mockBuildDeploymentTransaction,
        deploy: mockDeploy,
      },
      account: {
        address: () => ({ to_string: () => "aleo1testdeployer" }),
      },
    });
  });

  afterEach(() => {
    fixture?.cleanup();
    delete process.env["LIONDEN_PROVE"];
    vi.restoreAllMocks();
  });

  /**
   * Create a temp project with Leo source files and pre-populated artifacts,
   * then build an LRE wired with a fake network.
   */
  function createDeployFixture(
    programs: {
      name: string;
      imports?: string[];
      annotation?: string;
      aleoSource?: string;
      records?: Array<{ path: string[]; fields: unknown[] }>;
    }[],
  ) {
    fixture = createContractLre({
      programs,
      withNetwork: true,
      withMockCompile: true,
      prePopulateArtifacts: programs.map((prog) => ({
        programId: `${prog.name}.aleo`,
        abi: {
          program: `${prog.name}.aleo`,
          structs: [],
          records: prog.records ?? [],
          mappings: [],
          storage_variables: [],
          transitions: [],
        },
        aleoSource:
          prog.aleoSource ??
          `program ${prog.name}.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`,
      })),
    });

    return {
      lre: fixture.lre,
      fakeNetwork: fixture.fakeNetwork!,
      artifactsDir: fixture.project.artifactsDir,
    };
  }

  it("deploys a single program through the full action path", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const taskResult = await deployAction({ program: "hello", noCompile: true }, lre);
    const results = unwrapDeploy(taskResult);

    expect(results).toHaveLength(1);
    expect(results[0]!.programId).toBe("hello.aleo");
    expect(results[0]!.txId).toBeDefined();

    // Verify network seam: broadcastTransaction was called
    const broadcastCalls = fakeNetwork.getCallsTo("broadcastTransaction");
    expect(broadcastCalls).toHaveLength(1);

    // Verify confirmation was awaited
    const confirmCalls = fakeNetwork.getCallsTo("waitForConfirmation");
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.args[0]).toBe(results[0]!.txId);

    // Constructor type recorded
    expect(results[0]!.constructorType).toBe("noupgrade");
  });

  it("uses the devnode fast-path when prove is not requested", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    await deployAction({ program: "hello", noCompile: true }, lre);

    expect(mockBuildDevnodeDeploymentTransaction).toHaveBeenCalledWith({
      program: expect.stringContaining("program hello.aleo"),
      priorityFee: 0,
      privateFee: false,
    });
    expect(mockBuildDeploymentTransaction).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe("mock-tx-bytes");
  });

  it("uses the standard deployment builder on devnode when prove is requested", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    await deployAction({ program: "hello", noCompile: true, prove: true }, lre);

    expect(mockBuildDevnodeDeploymentTransaction).not.toHaveBeenCalled();
    expect(mockBuildDeploymentTransaction).toHaveBeenCalledWith(
      expect.stringContaining("program hello.aleo"),
      0,
      false,
    );
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "standard-deploy-tx-bytes",
    );
  });

  it("keeps record programs on the devnode fast-path when prove is not requested", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      {
        name: "hello",
        annotation: "@noupgrade\n    constructor() {}",
        records: [{ path: ["Bid"], fields: [] }],
        aleoSource:
          `program hello.aleo;\n` +
          `record Bid:\n` +
          `  owner as address.private;\n` +
          `function main:\n` +
          `  input r0 as u32.private;\n` +
          `  output r0 as u32.private;\n`,
      },
    ]);

    await deployAction({ program: "hello", noCompile: true }, lre);

    expect(mockBuildDevnodeDeploymentTransaction).toHaveBeenCalledWith({
      program: expect.stringContaining("record Bid:"),
      priorityFee: 0,
      privateFee: false,
    });
    expect(mockBuildDeploymentTransaction).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe("mock-tx-bytes");
  });

  it("uses LIONDEN_PROVE to select the standard deployment builder", async () => {
    process.env["LIONDEN_PROVE"] = "true";
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    await deployAction({ program: "hello", noCompile: true }, lre);

    expect(mockBuildDevnodeDeploymentTransaction).not.toHaveBeenCalled();
    expect(mockBuildDeploymentTransaction).toHaveBeenCalledWith(
      expect.stringContaining("program hello.aleo"),
      0,
      false,
    );
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "standard-deploy-tx-bytes",
    );
  });

  it("uses lre.globalOptions.prove (the --prove global option) to select the standard deployment builder", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    // Simulates `lionden --prove deploy` AND `lionden deploy --prove`: the CLI
    // parser records --prove into lre.globalOptions in either position, with no
    // task arg set. resolveProveOption must honor it.
    lre.globalOptions["prove"] = true;

    await deployAction({ program: "hello", noCompile: true }, lre);

    expect(mockBuildDevnodeDeploymentTransaction).not.toHaveBeenCalled();
    expect(mockBuildDeploymentTransaction).toHaveBeenCalledWith(
      expect.stringContaining("program hello.aleo"),
      0,
      false,
    );
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(
      "standard-deploy-tx-bytes",
    );
  });

  it("throws when proving is requested but the standard deployment builder is unavailable", async () => {
    mockCreateSdkObjects.mockResolvedValue({
      programManager: {
        buildDevnodeDeploymentTransaction: mockBuildDevnodeDeploymentTransaction,
      },
      account: {
        address: () => ({ to_string: () => "aleo1testdeployer" }),
      },
    });
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    await expect(
      deployAction({ program: "hello", noCompile: true, prove: true }, lre),
    ).rejects.toThrow(/buildDeploymentTransaction/);
    expect(mockBuildDevnodeDeploymentTransaction).not.toHaveBeenCalled();
  });

  it("uses the standard deployment builder for proving dry-run transactions", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const result = await deployAction(
      { program: "hello", noCompile: true, dryRun: true, prove: true },
      lre,
    );

    expect(mockBuildDevnodeDeploymentTransaction).not.toHaveBeenCalled();
    expect(mockBuildDeploymentTransaction).toHaveBeenCalledWith(
      expect.stringContaining("program hello.aleo"),
      0,
      false,
    );
    expect(result).toEqual({
      mode: "dry-run",
      results: [
        {
          programId: "hello.aleo",
          transaction: "standard-deploy-tx-bytes",
          estimatedFee: 0n,
        },
      ],
    });
  });

  it("deploys multi-program projects in dependency order", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "dep", annotation: "@noupgrade\n    constructor() {}" },
      { name: "app", imports: ["dep.aleo"], annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const taskResult = await deployAction({ noCompile: true }, lre);
    const results = unwrapDeploy(taskResult);

    // Both programs deployed
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.programId);

    // dep must be deployed before app (topological order)
    expect(ids.indexOf("dep.aleo")).toBeLessThan(ids.indexOf("app.aleo"));

    // broadcastTransaction called once per program
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(2);
  });

  it("throws DeployError when constructor annotation is missing", async () => {
    const { lre } = createDeployFixture([
      // No annotation at all — parser should return null
      { name: "noctor", annotation: "" },
    ]);

    await expect(deployAction({ program: "noctor", noCompile: true }, lre)).rejects.toThrow(
      DeployError,
    );
  });

  it("throws DeployError when confirmation returns rejected status", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    fakeNetwork.setConfirmBehavior("reject");

    await expect(deployAction({ program: "hello", noCompile: true }, lre)).rejects.toThrow(
      DeployError,
    );
  });

  it("skips confirmation when skipConfirm is true", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    await deployAction({ program: "hello", noCompile: true, skipConfirm: true }, lre);

    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
  });

  it("skips compile when noCompile is true", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const compileSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({ program: "hello", noCompile: true }, lre);

    const taskIds = compileSpy.mock.calls.map((c) => c[0]);
    expect(taskIds).not.toContain("compile");
  });

  it("scopes implicit compile to the selected bare program", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const compileSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({ program: "hello" }, lre);

    expect(compileSpy).toHaveBeenCalledWith("compile", { program: "hello" });
  });

  it("passes the selected .aleo program through to implicit compile", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const compileSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({ program: "hello.aleo" }, lre);

    expect(compileSpy).toHaveBeenCalledWith("compile", {
      program: "hello.aleo",
    });
  });

  it("runs full implicit compile when no program is selected", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const compileSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({}, lre);

    expect(compileSpy).toHaveBeenCalledWith("compile");
  });

  it("skips compile when preflight is true", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const compileSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({ program: "hello", preflight: true }, lre);

    const taskIds = compileSpy.mock.calls.map((c) => c[0]);
    expect(taskIds).not.toContain("compile");
  });

  it("returns preflight result when --preflight flag is set", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const taskResult = await deployAction(
      { program: "hello", noCompile: true, preflight: true },
      lre,
    );

    expect(taskResult.mode).toBe("preflight");
    if (taskResult.mode === "preflight") {
      expect(taskResult.result).toBeDefined();
      expect(taskResult.result.programs).toHaveLength(1);
    }
  });

  it("skips already-deployed programs (devnode: not on-chain = deploy)", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    // FakeNetworkConnection.getProgramSource returns null by default → not on-chain → deploys
    const taskResult = await deployAction({ program: "hello", noCompile: true }, lre);
    const results = unwrapDeploy(taskResult);
    expect(results).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // SDK plumbing — every createSdkObjects() inside the deploy flow must
  // carry the resolved keyCache from config and the egressPolicy from the
  // active connection. Load-bearing for two reasons: keyCache propagation
  // amortizes credits-key persistence across throwaway SDK objects, and
  // egressPolicy is what installs the guarded network transport that
  // forces `hasCustomTransport=true` and scopes chain-state/submission
  // egress to the connection endpoint. A regression dropping either field
  // on any of the four call sites is caught here.
  // -------------------------------------------------------------------------
  describe("createSdkObjects plumbing", () => {
    it("passes keyCache and egressPolicy to every createSdkObjects call on devnode deploy", async () => {
      const { lre, fakeNetwork } = createDeployFixture([
        { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
      ]);

      await deployAction({ program: "hello", noCompile: true }, lre);

      // resolveDeployerAddress + deployToNetwork → at least two construction sites
      expect(mockCreateSdkObjects.mock.calls.length).toBeGreaterThanOrEqual(1);
      for (const call of mockCreateSdkObjects.mock.calls) {
        const opts = call[0];
        expect(opts).toMatchObject({
          network: fakeNetwork.networkId,
          endpoint: fakeNetwork.endpoint,
          egressPolicy: fakeNetwork.egressPolicy,
        });
      }
      // deployToNetwork should also carry the resolved keyCache. Filter to
      // the calls that came through the helper (signerKey present + apiKey
      // forwarded) — resolveDeployerAddress doesn't pass keyCache.
      const helperCalls = mockCreateSdkObjects.mock.calls.filter((c) => "apiKey" in (c[0] ?? {}));
      expect(helperCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of helperCalls) {
        expect(call[0]).toMatchObject({
          keyCache: lre.config.sdk.keyCache,
        });
      }
    });

    it("propagates the egressPolicy when LIONDEN_PROVE forces the standard deployment builder", async () => {
      process.env["LIONDEN_PROVE"] = "true";
      const { lre, fakeNetwork } = createDeployFixture([
        { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
      ]);

      await deployAction({ program: "hello", noCompile: true }, lre);

      // Even on the prove branch, every SDK construction must carry the
      // connection's egress policy. This is exactly the case that would
      // reintroduce the leak if a future call site dropped the field.
      for (const call of mockCreateSdkObjects.mock.calls) {
        expect(call[0]).toMatchObject({
          egressPolicy: fakeNetwork.egressPolicy,
        });
      }
    });
  });
});
