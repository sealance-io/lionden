/**
 * Tier 2 contract test — crosses: @lionden/plugin-deploy + @lionden/leo-compiler + @lionden/network
 *
 * Tests the full deploy orchestration: deployAction() calls real discoverUnits()
 * and resolveDependencies() from leo-compiler, resolves deploy targets, parses
 * constructors from Leo source, and broadcasts through a mocked NetworkConnection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  KEY_ARTIFACTS_FORMAT,
  keyArtifactsMetadataPath,
  sha256Json,
  sha256Text,
  writeKeyArtifactsMetadata,
} from "@lionden/core";
import type { ProgramABI } from "@lionden/leo-compiler";
import { type NetworkManager, SdkDiagnostics } from "@lionden/network";
import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployError, type DeployTaskResult, deployAction } from "./deploy-task.js";
import { DeploymentManagerImpl } from "./deployment-manager.js";

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
      diagnostics: new SdkDiagnostics(),
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
      source?: string;
      imports?: string[];
      annotation?: string;
      aleoSource?: string;
      records?: Array<{ path: string[]; fields: unknown[] }>;
    }[],
    configOverrides = {},
  ) {
    fixture = createContractLre({
      programs,
      configOverrides,
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
    const manager = new DeploymentManagerImpl(
      fixture.lre.config,
      () => fixture.lre.network as NetworkManager | null,
      fixture.lre.artifacts,
    );
    (fixture.lre as unknown as Record<string, unknown>)["deployments"] = manager;
    const programState = programs.map((prog) => ({
      programId: `${prog.name}.aleo`,
      source:
        prog.aleoSource ??
        `program ${prog.name}.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`,
      edition: 0,
    }));
    const broadcastTransaction = fixture.fakeNetwork!.broadcastTransaction.bind(
      fixture.fakeNetwork!,
    );
    let broadcastIndex = 0;
    vi.spyOn(fixture.fakeNetwork!, "broadcastTransaction").mockImplementation(
      async (transaction) => {
        const program = programState[broadcastIndex++];
        if (program) {
          fixture.fakeNetwork!.setProgramSource(program.programId, program.source);
          fixture.fakeNetwork!.setProgramEdition(program.programId, program.edition);
        }
        return broadcastTransaction(transaction);
      },
    );

    return {
      lre: fixture.lre,
      fakeNetwork: fixture.fakeNetwork!,
      artifactsDir: fixture.project.artifactsDir,
      programsDir: fixture.project.programsDir,
    };
  }

  function writeLibrary(programsDir: string, name: string): void {
    const dir = path.join(programsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "lib.leo"), "fn helper() {}\n");
  }

  function writeArtifactProvenance(
    artifactsDir: string,
    programId: string,
    sourceProgramId: string,
  ): void {
    writeKeyArtifactsMetadata(keyArtifactsMetadataPath(artifactsDir, programId), {
      format: KEY_ARTIFACTS_FORMAT,
      programId,
      sourceProgramId,
      sourceHash: sha256Text(`program ${programId};\n`),
      importsHash: sha256Json({ imports: [] }),
    });
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

    const manager = lre.deployments as DeploymentManagerImpl;
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.edition).toBe(0);
  });

  it("rejects dependency-conflicting and build-test renames", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre } = createDeployFixture(
      [
        { name: "utils", annotation: "@noupgrade\n    constructor() {}" },
        {
          name: "hello",
          imports: ["utils.aleo"],
          annotation: "@noupgrade\n    constructor() {}",
        },
      ],
      { leoVersion: "4.3.2", compiler },
    );

    await expect(deployAction({ program: "hello", rename: "utils" }, lre)).rejects.toThrow(
      /conflicts with another local unit/,
    );

    (lre.config as unknown as { compiler: typeof compiler }).compiler = {
      ...compiler,
      buildTests: true,
    };
    await expect(deployAction({ program: "hello", rename: "renamed_hello" }, lre)).rejects.toThrow(
      /buildTests/,
    );
  });

  it("allows same-as-source rename through deploy orchestration", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );

    const taskResult = await deployAction({ program: "hello", rename: "hello" }, lre);
    const results = unwrapDeploy(taskResult);

    expect(results.map((result) => result.programId)).toEqual(["hello.aleo"]);
    const manager = lre.deployments as DeploymentManagerImpl;
    expect(manager.getCached("hello.aleo", "devnode")).toMatchObject({
      programId: "hello.aleo",
      sourceProgramId: "hello.aleo",
    });
  });

  it("does not reject invalid rename values during rename validation", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, fakeNetwork } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );
    const connectSpy = vi.spyOn(lre.network as NetworkManager, "connect");

    await expect(
      deployAction({ program: "hello", rename: "bad-name", noCompile: true }, lre),
    ).rejects.toThrow(/Missing artifact provenance metadata.*without --noCompile/s);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("rejects renaming a program to the name of a local library", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, programsDir } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );
    writeLibrary(programsDir, "math");

    await expect(deployAction({ program: "hello", rename: "math" }, lre)).rejects.toThrow(
      /conflicts with another local unit/,
    );
  });

  it("rejects renaming to the .aleo form of an imported local library", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, programsDir } = createDeployFixture(
      [
        {
          name: "hello",
          source: "import math.aleo;\nprogram hello.aleo {\n  @noupgrade\n  constructor() {}\n}\n",
        },
      ],
      { leoVersion: "4.3.2", compiler },
    );
    writeLibrary(programsDir, "math");

    await expect(deployAction({ program: "hello", rename: "math.aleo" }, lre)).rejects.toThrow(
      /conflicts with another local unit/,
    );
  });

  it("does not reject renaming to a transitive imported dependency during rename validation", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre } = createDeployFixture(
      [
        {
          name: "dep",
          source: "import tenant.aleo;\nprogram dep.aleo {\n  @noupgrade\n  constructor() {}\n}\n",
        },
        {
          name: "app",
          imports: ["dep.aleo"],
          annotation: "@noupgrade\n    constructor() {}",
        },
      ],
      { leoVersion: "4.3.2", compiler },
    );
    const runSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({ program: "app", rename: "tenant", preflight: true }, lre);

    expect(runSpy).not.toHaveBeenCalled();
  });

  it("deploys a renamed program using renamed runtime identity and source provenance", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, artifactsDir } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );
    lre.artifacts.setAbi("renamed_hello.aleo", {
      program: "renamed_hello.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    });
    lre.artifacts.setAleoSource(
      "renamed_hello.aleo",
      "program renamed_hello.aleo;\nfunction main:\n",
    );
    writeArtifactProvenance(artifactsDir, "renamed_hello.aleo", "hello.aleo");

    const taskResult = await deployAction(
      { program: "hello", rename: "renamed_hello", noCompile: true, skipConfirm: true },
      lre,
    );
    const results = unwrapDeploy(taskResult);

    expect(results.map((result) => result.programId)).toEqual(["renamed_hello.aleo"]);
    const manager = lre.deployments as DeploymentManagerImpl;
    const record = manager.getCached("renamed_hello.aleo", "devnode");
    expect(record?.programId).toBe("renamed_hello.aleo");
    expect(record?.sourceProgramId).toBe("hello.aleo");
    expect(manager.getCached("hello.aleo", "devnode")).toBeNull();
  });

  it("plain unfiltered deploy ignores stale renamed artifacts instead of deploying them", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    vi.spyOn(lre.artifacts, "getProgramIds").mockReturnValue(["tenant.aleo"]);

    await expect(deployAction({ noCompile: true }, lre)).rejects.toThrow(
      "No compiled programs found",
    );

    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("rejects renamed noCompile when artifact provenance is missing", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, fakeNetwork } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );
    const connectSpy = vi.spyOn(lre.network as NetworkManager, "connect");
    lre.artifacts.setAbi("renamed_hello.aleo", {
      program: "renamed_hello.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    });
    lre.artifacts.setAleoSource(
      "renamed_hello.aleo",
      "program renamed_hello.aleo;\nfunction main:\n",
    );

    await expect(
      deployAction({ program: "hello", rename: "renamed_hello", noCompile: true }, lre),
    ).rejects.toThrow(/Missing artifact provenance metadata.*without --noCompile/s);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("rejects an already-deployed renamed target without matching local provenance", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, fakeNetwork, artifactsDir } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );
    lre.artifacts.setAbi("tenant.aleo", {
      program: "tenant.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    });
    lre.artifacts.setAleoSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    writeArtifactProvenance(artifactsDir, "tenant.aleo", "hello.aleo");
    fakeNetwork.setProgramSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    fakeNetwork.setProgramEdition("tenant.aleo", 0);

    await expect(
      deployAction({ program: "hello", rename: "tenant", noCompile: true, skipConfirm: true }, lre),
    ).rejects.toThrow(/already exists but has no matching local provenance/);

    const manager = lre.deployments as DeploymentManagerImpl;
    expect(manager.getCached("tenant.aleo", "devnode")).toBeNull();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("rejects renamed reuse when the local record has different source provenance", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, fakeNetwork, artifactsDir } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );
    lre.artifacts.setAbi("tenant.aleo", {
      program: "tenant.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    });
    lre.artifacts.setAleoSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    writeArtifactProvenance(artifactsDir, "tenant.aleo", "hello.aleo");
    fakeNetwork.setProgramSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    fakeNetwork.setProgramEdition("tenant.aleo", 0);

    const manager = lre.deployments as DeploymentManagerImpl;
    await manager.record(
      {
        status: "complete",
        programId: "tenant.aleo",
        sourceProgramId: "other.aleo",
        network: "devnode",
        endpoint: fakeNetwork.endpoint,
        updatedAt: "2026-04-01T00:00:00.000Z",
        edition: 0,
        historyCount: 1,
        txId: "at1other",
        blockHeight: 1,
        deployerAddress: "aleo1testdeployer",
        deployedAt: "2026-04-01T00:00:00.000Z",
      },
      "deploy",
      { abi: lre.artifacts.getAbi("tenant.aleo") as ProgramABI },
    );

    await expect(
      deployAction({ program: "hello", rename: "tenant", noCompile: true, skipConfirm: true }, lre),
    ).rejects.toThrow(
      /Renamed deploy target "tenant\.aleo" is already associated with source "other\.aleo", not "hello\.aleo"/,
    );
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("rejects plain reuse when the local record is bound to a different source program", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "tenant", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    fakeNetwork.setProgramSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    fakeNetwork.setProgramEdition("tenant.aleo", 0);

    const manager = lre.deployments as DeploymentManagerImpl;
    await manager.record(
      {
        status: "complete",
        programId: "tenant.aleo",
        sourceProgramId: "hello.aleo",
        network: "devnode",
        endpoint: fakeNetwork.endpoint,
        updatedAt: "2026-04-01T00:00:00.000Z",
        edition: 0,
        historyCount: 1,
        txId: "at1renamed",
        blockHeight: 1,
        deployerAddress: "aleo1testdeployer",
        deployedAt: "2026-04-01T00:00:00.000Z",
      },
      "deploy",
      { abi: lre.artifacts.getAbi("tenant.aleo") as ProgramABI },
    );

    await expect(
      deployAction({ program: "tenant", noCompile: true, skipConfirm: true }, lre),
    ).rejects.toThrow(
      /Deploy target "tenant\.aleo" is already associated with source "hello\.aleo", not "tenant\.aleo"/,
    );
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("rejects renamed preflight when the local record has different source provenance", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, fakeNetwork, artifactsDir } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );
    lre.artifacts.setAbi("tenant.aleo", {
      program: "tenant.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    });
    lre.artifacts.setAleoSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    writeArtifactProvenance(artifactsDir, "tenant.aleo", "hello.aleo");
    fakeNetwork.setProgramSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    fakeNetwork.setProgramEdition("tenant.aleo", 0);

    const manager = lre.deployments as DeploymentManagerImpl;
    await manager.record(
      {
        status: "complete",
        programId: "tenant.aleo",
        sourceProgramId: "other.aleo",
        network: "devnode",
        endpoint: fakeNetwork.endpoint,
        updatedAt: "2026-04-01T00:00:00.000Z",
        edition: 0,
        historyCount: 1,
        txId: "at1other",
        blockHeight: 1,
        deployerAddress: "aleo1testdeployer",
        deployedAt: "2026-04-01T00:00:00.000Z",
      },
      "deploy",
      { abi: lre.artifacts.getAbi("tenant.aleo") as ProgramABI },
    );

    await expect(
      deployAction({ program: "hello", rename: "tenant", noCompile: true, preflight: true }, lre),
    ).rejects.toThrow(
      /Renamed deploy target "tenant\.aleo" is already associated with source "other\.aleo", not "hello\.aleo"/,
    );
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("reuses renamed deployment provenance from disk-backed devnode state on a cold cache", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, fakeNetwork, artifactsDir } = createDeployFixture(
      [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      { leoVersion: "4.3.2", compiler },
    );
    (lre.config.networks.devnode as { ephemeral?: boolean }).ephemeral = false;
    lre.artifacts.setAbi("tenant.aleo", {
      program: "tenant.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    });
    lre.artifacts.setAleoSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    writeArtifactProvenance(artifactsDir, "tenant.aleo", "hello.aleo");
    fakeNetwork.setProgramSource("tenant.aleo", "program tenant.aleo;\nfunction main:\n");
    fakeNetwork.setProgramEdition("tenant.aleo", 0);

    const warmManager = lre.deployments as DeploymentManagerImpl;
    await warmManager.record(
      {
        status: "complete",
        programId: "tenant.aleo",
        sourceProgramId: "hello.aleo",
        network: "devnode",
        endpoint: fakeNetwork.endpoint,
        updatedAt: "2026-04-01T00:00:00.000Z",
        edition: 0,
        historyCount: 1,
        txId: "at1tenant",
        blockHeight: 1,
        deployerAddress: "aleo1testdeployer",
        deployedAt: "2026-04-01T00:00:00.000Z",
      },
      "deploy",
      { abi: lre.artifacts.getAbi("tenant.aleo") as ProgramABI },
    );
    const coldManager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );
    (lre as unknown as Record<string, unknown>)["deployments"] = coldManager;

    const taskResult = await deployAction(
      { program: "hello", rename: "tenant", noCompile: true, skipConfirm: true },
      lre,
    );

    expect(unwrapDeploy(taskResult)).toEqual([]);
    expect(coldManager.getCached("tenant.aleo", "devnode")).toMatchObject({
      status: "complete",
      programId: "tenant.aleo",
      sourceProgramId: "hello.aleo",
    });
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("rejects renamed noCompile when artifact provenance has a different source", async () => {
    const compiler = {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    };
    const { lre, fakeNetwork, artifactsDir } = createDeployFixture(
      [
        { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
        { name: "other", annotation: "@noupgrade\n    constructor() {}" },
      ],
      { leoVersion: "4.3.2", compiler },
    );
    const connectSpy = vi.spyOn(lre.network as NetworkManager, "connect");
    lre.artifacts.setAbi("renamed_hello.aleo", {
      program: "renamed_hello.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    });
    lre.artifacts.setAleoSource(
      "renamed_hello.aleo",
      "program renamed_hello.aleo;\nfunction main:\n",
    );
    writeArtifactProvenance(artifactsDir, "renamed_hello.aleo", "other.aleo");

    await expect(
      deployAction({ program: "hello", rename: "renamed_hello", noCompile: true }, lre),
    ).rejects.toThrow(/sourceProgramId="other\.aleo".*without --noCompile/s);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("records a confirmed deploy even when on-chain edition cannot be observed", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    vi.spyOn(fakeNetwork, "getProgramEdition").mockResolvedValue(null);

    await deployAction({ program: "hello", noCompile: true }, lre);

    const manager = lre.deployments as DeploymentManagerImpl;
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    if (record?.status === "complete") {
      expect(record.edition).toBe(0);
    }
  });

  it("records edition 0 for skip-confirm when on-chain edition is not yet visible", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    vi.spyOn(fakeNetwork, "getProgramEdition").mockResolvedValue(null);

    await deployAction({ program: "hello", noCompile: true, skipConfirm: true }, lre);

    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
    const manager = lre.deployments as DeploymentManagerImpl;
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    if (record?.status === "complete") {
      expect(record.edition).toBe(0);
    }
  });

  it("fails explicit export when deploy confirmation is skipped", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    const manager = lre.deployments as DeploymentManagerImpl;
    const exportSpy = vi.spyOn(manager, "export");

    await expect(
      deployAction({ program: "hello", noCompile: true, skipConfirm: true, export: true }, lre),
    ).rejects.toThrow(/export.*confirmation is skipped/i);
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
    expect(manager.getCached("hello.aleo", "devnode")).toBeNull();
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("skips auto-export when deploy confirmation is skipped", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    (lre.config.deploy as { autoExport: boolean }).autoExport = true;
    const manager = lre.deployments as DeploymentManagerImpl;
    const exportSpy = vi.spyOn(manager, "export");

    await deployAction({ program: "hello", noCompile: true, skipConfirm: true }, lre);

    expect(exportSpy).not.toHaveBeenCalled();
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    expect(record?.edition).toBe(0);
  });

  it("exports after a confirmed deploy when explicitly requested", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    const manager = lre.deployments as DeploymentManagerImpl;
    const exportSpy = vi.spyOn(manager, "export");

    await deployAction({ program: "hello", noCompile: true, export: true }, lre);

    expect(exportSpy).toHaveBeenCalledWith("devnode");
    const record = manager.getCached("hello.aleo", "devnode");
    expect(record?.status).toBe("complete");
    expect(record?.edition).toBe(0);
  });

  it("honors a programmatic network override", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    (lre.config.networks as Record<string, unknown>)["testnet"] = {
      ...lre.config.networks.devnode,
    };
    const connect = vi
      .spyOn(lre.network as NetworkManager, "connect")
      .mockResolvedValue(fakeNetwork);

    await deployAction({ program: "hello", noCompile: true, network: "testnet" }, lre);

    expect(connect).toHaveBeenCalledWith("testnet");
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

  it("treats a permissive LIONDEN_PROVE spelling (1) as proving and selects the standard builder", async () => {
    process.env["LIONDEN_PROVE"] = "1";
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

  it("lets an explicit --prove=false global override LIONDEN_PROVE (I5: stays on the devnode fast-path)", async () => {
    process.env["LIONDEN_PROVE"] = "true";
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    // `LIONDEN_PROVE=true lionden deploy --prove=false`: the explicit global
    // boolean must win over the env var, so proving is disabled.
    lre.globalOptions["prove"] = false;

    await deployAction({ program: "hello", noCompile: true }, lre);

    expect(mockBuildDevnodeDeploymentTransaction).toHaveBeenCalled();
    expect(mockBuildDeploymentTransaction).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe("mock-tx-bytes");
  });

  it("throws when proving is requested but the standard deployment builder is unavailable", async () => {
    mockCreateSdkObjects.mockResolvedValue({
      programManager: {
        buildDevnodeDeploymentTransaction: mockBuildDevnodeDeploymentTransaction,
      },
      account: {
        address: () => ({ to_string: () => "aleo1testdeployer" }),
      },
      diagnostics: new SdkDiagnostics(),
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

  it("forwards an explicit network into the implicit compile", async () => {
    const { lre, fakeNetwork } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);
    (lre.config.networks as Record<string, unknown>)["testnet"] = {
      ...lre.config.networks.devnode,
    };
    vi.spyOn(lre.network as NetworkManager, "connect").mockResolvedValue(fakeNetwork);
    const compileSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({ program: "hello", network: "testnet" }, lre);

    // The implicit compile must resolve network deps + `.env` for the deploying
    // network — so the explicit network is threaded through as a passthrough arg.
    expect(compileSpy).toHaveBeenCalledWith("compile", {
      program: "hello",
      network: "testnet",
    });
  });

  it("omits network from the implicit compile on a default-network run", async () => {
    const { lre } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const compileSpy = vi.spyOn(lre.tasks, "run");

    await deployAction({ program: "hello" }, lre);

    // No explicit network → compile gets no `network` key, so it falls back to
    // config.defaultNetwork exactly as before.
    expect(compileSpy).toHaveBeenCalledWith("compile", { program: "hello" });
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
