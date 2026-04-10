/**
 * Tier 2 contract test — crosses: @lionden/plugin-deploy + @lionden/leo-compiler + @lionden/network
 *
 * Tests the full deploy orchestration: deployAction() calls real discoverUnits()
 * and resolveDependencies() from leo-compiler, resolves deploy targets, parses
 * constructors from Leo source, and broadcasts through a mocked NetworkConnection.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createLre, task, type LionDenPlugin } from "@lionden/core";
import { createMockConfig, createMockConnection } from "@lionden/test-internals";
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
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Create a temp project with Leo source files and pre-populated artifacts,
   * then build an LRE wired with a mock network plugin.
   */
  function createDeployFixture(
    programs: { name: string; imports?: string[]; annotation?: string }[],
  ) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-deploy-contract-"));
    const programsDir = path.join(tmpDir, "programs");
    const artifactsDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });

    // Write Leo source files
    for (const prog of programs) {
      const progDir = path.join(programsDir, prog.name);
      fs.mkdirSync(progDir, { recursive: true });

      const importLines = (prog.imports ?? [])
        .map((imp) => `import ${imp};`)
        .join("\n");

      const constructorBlock = prog.annotation ?? "@noupgrade\n    constructor() {}";

      fs.writeFileSync(
        path.join(progDir, "main.leo"),
        `${importLines}
program ${prog.name}.aleo {
    ${constructorBlock}

    transition main(a: u32, b: u32) -> u32 {
        return a + b;
    }
}
`,
      );
    }

    // Build config
    const config = createMockConfig({
      paths: {
        root: tmpDir,
        programs: programsDir,
        artifacts: artifactsDir,
        typechain: path.join(tmpDir, "typechain"),
        cache: path.join(tmpDir, "cache"),
      },
    });

    // Mock connection that captures broadcastTransaction calls
    const mockConn = createMockConnection({
      broadcastTransaction: vi.fn().mockResolvedValue("at1deployed"),
      waitForConfirmation: vi.fn().mockResolvedValue({
        txId: "at1deployed",
        blockHeight: 42,
        status: "accepted",
      }),
    });

    // Mock network plugin that provides the connection
    const networkPlugin: LionDenPlugin = {
      id: "mock-network",
      name: "Mock Network",
      extendLre(lre) {
        (lre as any).network = {
          connect: vi.fn().mockResolvedValue(mockConn),
          getConnection: vi.fn().mockReturnValue(mockConn),
          disconnectAll: vi.fn().mockResolvedValue(undefined),
          getAccounts: vi.fn().mockReturnValue([]),
          execute: vi.fn(),
          getMappingValue: vi.fn(),
        };
      },
    };

    // Mock compile task (deployAction calls lre.tasks.run("compile"))
    const compilePlugin: LionDenPlugin = {
      id: "mock-compile",
      tasks: [
        task("compile", "Mock compile")
          .setAction(async () => {})
          .build(),
      ],
    };

    const lre = createLre({ config, plugins: [compilePlugin, networkPlugin] });

    // Pre-populate artifacts (simulating prior compilation)
    for (const prog of programs) {
      const aleoSource = `program ${prog.name}.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`;
      lre.artifacts.setAbi(
        `${prog.name}.aleo`,
        { program: `${prog.name}.aleo`, functions: [], structs: [], records: [], mappings: [] },
      );
      lre.artifacts.setAleoSource(`${prog.name}.aleo`, aleoSource);
    }

    return { lre, mockConn, artifactsDir };
  }

  it("deploys a single program through the full action path", async () => {
    const { lre, mockConn, artifactsDir } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    const results = await deployAction(
      { program: "hello", noCompile: true },
      lre,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.programId).toBe("hello.aleo");
    expect(results[0]!.txId).toBe("at1deployed");
    expect(results[0]!.blockHeight).toBe(42);

    // Verify network seam: broadcastTransaction was called
    expect(mockConn.broadcastTransaction).toHaveBeenCalledOnce();

    // Verify confirmation was awaited
    expect(mockConn.waitForConfirmation).toHaveBeenCalledWith(
      "at1deployed",
      expect.any(Number),
    );

    // Verify deploy manifest was written
    const manifest = readDeployManifest(artifactsDir, "hello.aleo");
    expect(manifest).not.toBeNull();
    expect(manifest!.programId).toBe("hello.aleo");
    expect(manifest!.txId).toBe("at1deployed");
    expect(manifest!.constructorType).toBe("noupgrade");
  });

  it("deploys multi-program projects in dependency order", async () => {
    const { lre, mockConn } = createDeployFixture([
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
    expect(mockConn.broadcastTransaction).toHaveBeenCalledTimes(2);
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
    const { lre, mockConn } = createDeployFixture([
      { name: "hello", annotation: "@noupgrade\n    constructor() {}" },
    ]);

    await deployAction(
      { program: "hello", noCompile: true, skipConfirm: true },
      lre,
    );

    expect(mockConn.waitForConfirmation).not.toHaveBeenCalled();
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
