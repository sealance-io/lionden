/**
 * Tier 2 contract test — crosses: @lionden/plugin-deploy + @lionden/leo-compiler + @lionden/network
 *
 * Tests the full deploy orchestration: deployAction() calls real discoverUnits()
 * and resolveDependencies() from leo-compiler, resolves deploy targets, parses
 * constructors from Leo source, and broadcasts through a mocked NetworkConnection.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createContractLre, type ContractLreResult } from "@lionden/test-internals";
import { deployAction, DeployError } from "./deploy-task.js";
import { readDeployManifest } from "./deploy-manifest.js";

// Mock @lionden/network's SDK layer to avoid real SDK instantiation.
// deployAction → buildAndBroadcastDeploy → import("@lionden/network")
vi.mock("@lionden/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/network")>();
  return {
    ...original,
    createSdkObjects: vi.fn().mockResolvedValue({
      programManager: {
        buildDevnodeDeploymentTransaction: vi.fn().mockResolvedValue("mock-tx-bytes"),
        deploy: vi.fn().mockResolvedValue("at1deploy"),
      },
    }),
    checkDevnodeSdkSupport: vi.fn().mockResolvedValue(undefined),
    initConsensusHeights: vi.fn().mockResolvedValue(undefined),
  };
});

describe("deploy orchestration contract", () => {
  let fixture: ContractLreResult;

  afterEach(() => {
    fixture?.cleanup();
  });

  /**
   * Create a temp project with Leo source files and pre-populated artifacts,
   * then build an LRE wired with a fake network.
   */
  function createDeployFixture(
    programs: { name: string; imports?: string[]; annotation?: string }[],
  ) {
    fixture = createContractLre({
      programs,
      withNetwork: true,
      withMockCompile: true,
      prePopulateArtifacts: programs.map((prog) => ({
        programId: `${prog.name}.aleo`,
        abi: { program: `${prog.name}.aleo`, functions: [], structs: [], records: [], mappings: [] },
        aleoSource: `program ${prog.name}.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`,
      })),
    });

    return {
      lre: fixture.lre,
      fakeNetwork: fixture.fakeNetwork!,
      artifactsDir: fixture.project.artifactsDir,
    };
  }

  it("deploys a single program through the full action path", async () => {
    const { lre, fakeNetwork, artifactsDir } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const results = await deployAction(
      { program: "hello", noCompile: true },
      lre,
    );

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

    // Verify deploy manifest was written
    const manifest = readDeployManifest(artifactsDir, "hello.aleo");
    expect(manifest).not.toBeNull();
    expect(manifest!.programId).toBe("hello.aleo");
    expect(manifest!.txId).toBe(results[0]!.txId);
    expect(manifest!.constructorType).toBe("noupgrade");
  });

  it("deploys multi-program projects in dependency order", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "dep", annotation: "@noupgrade\n    constructor() {}" },
      { name: "app", imports: ["dep.aleo"], annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const results = await deployAction({ noCompile: true }, lre);

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

    await expect(
      deployAction({ program: "noctor", noCompile: true }, lre),
    ).rejects.toThrow(DeployError);
  });

  it("skips confirmation when skipConfirm is true", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    await deployAction(
      { program: "hello", noCompile: true, skipConfirm: true },
      lre,
    );

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

  it("runs compile when noCompile is not set", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const compileSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({ program: "hello" }, lre);

    const taskIds = compileSpy.mock.calls.map((c) => c[0]);
    expect(taskIds).toContain("compile");
  });
});
