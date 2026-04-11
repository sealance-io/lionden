/**
 * Tier 2 contract test — crosses: @lionden/plugin-deploy + @lionden/leo-compiler + @lionden/network
 *
 * Tests the full upgrade orchestration: upgradeAction() reads the old ABI from
 * disk, calls compile (which refreshes in-memory artifacts), checks ABI
 * compatibility, then builds and broadcasts an upgrade transaction through a
 * mocked NetworkConnection.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createContractLre, type ContractLreResult } from "@lionden/test-internals";
import { task } from "@lionden/core";
import type { LionDenRuntimeEnvironment, LionDenPlugin } from "@lionden/core";
import { upgradeAction, UpgradeCompatibilityError } from "./upgrade-task.js";
import { DeployError } from "./deploy-task.js";
import { writeDeployManifest, readDeployManifest, type DeployManifest } from "./deploy-manifest.js";

const DEVNODE_ACCOUNT_0 =
  "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

// Mock @lionden/network's SDK layer — upgrade-specific builders
vi.mock("@lionden/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/network")>();
  return {
    ...original,
    createSdkObjects: vi.fn().mockResolvedValue({
      programManager: {
        buildDevnodeUpgradeTransaction: vi
          .fn()
          .mockResolvedValue("mock-upgrade-tx-bytes"),
        buildUpgradeTransaction: vi
          .fn()
          .mockResolvedValue("mock-upgrade-tx-bytes"),
      },
      account: {
        address: () => ({
          to_string: () => DEVNODE_ACCOUNT_0,
        }),
      },
    }),
    checkDevnodeSdkSupport: vi.fn().mockResolvedValue(undefined),
    initConsensusHeights: vi.fn().mockResolvedValue(undefined),
  };
});

/** Minimal ABI with one mapping and one transition. */
function makeAbi(opts?: { mappings?: string[] }) {
  const mappings = (opts?.mappings ?? ["counters"]).map((name) => ({
    name,
    key: { type: "primitive" as const, value: "Address" },
    value: { type: "primitive" as const, value: "U64" },
  }));

  return {
    program: "hello.aleo",
    transitions: [
      { name: "increment", inputs: [], outputs: [], is_async: false },
    ],
    structs: [],
    records: [],
    mappings,
    storage_variables: [],
  };
}

describe("upgrade orchestration contract", () => {
  let fixture: ContractLreResult;

  afterEach(() => {
    fixture?.cleanup();
  });

  /**
   * Create a temp project with an @admin-annotated program, pre-written deploy
   * manifest and old ABI on disk, and a custom compile task that refreshes
   * in-memory artifacts.
   */
  function createUpgradeFixture(opts?: {
    constructorType?: "admin" | "noupgrade" | "custom";
    /** Old ABI mappings to write to disk */
    oldMappings?: string[];
    /** New ABI mappings that compile produces */
    newMappings?: string[];
    /** Skip writing old ABI to disk */
    skipOldAbi?: boolean;
    /** Skip writing deploy manifest */
    skipManifest?: boolean;
    /** Edition to write in manifest */
    edition?: number;
    /** Constructor annotation for Leo source */
    sourceAnnotation?: string;
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
          : '@custom(id="test")\n    constructor() {}');

    const oldAbi = makeAbi({ mappings: oldMappings });
    const newAbi = makeAbi({ mappings: newMappings });
    const aleoSource =
      `program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`;

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
            // Simulate compilation: replace in-memory artifacts with new ABI
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
    const artifactsDir = project.artifactsDir;

    // Write old ABI to disk (readOldAbi reads from filesystem, not lre.artifacts)
    if (!opts?.skipOldAbi) {
      const abiDir = path.join(artifactsDir, "hello.aleo");
      fs.mkdirSync(abiDir, { recursive: true });
      fs.writeFileSync(
        path.join(abiDir, "abi.json"),
        JSON.stringify(oldAbi, null, 2),
      );
    }

    // Write deploy manifest
    if (!opts?.skipManifest) {
      writeDeployManifest(artifactsDir, {
        programId: "hello.aleo",
        network: "devnode",
        endpoint: "http://127.0.0.1:3030",
        txId: "at1original",
        blockHeight: 1,
        edition,
        constructorType,
        constructorAdmin:
          constructorType === "admin" ? DEVNODE_ACCOUNT_0 : null,
        deployedAt: "2026-04-01T00:00:00.000Z",
      });
    }

    return {
      lre,
      fakeNetwork: fakeNetwork!,
      artifactsDir,
      getCompileCalled: () => compileCalled,
      getCompileArgs: () => compileArgs,
    };
  }

  it("upgrades a program with @admin constructor through the full action path", async () => {
    const { lre, fakeNetwork, artifactsDir, getCompileCalled, getCompileArgs } =
      createUpgradeFixture({ constructorType: "admin" });

    const result = await upgradeAction({ program: "hello" }, lre);

    expect(result.programId).toBe("hello.aleo");
    expect(result.txId).toBeDefined();
    expect(result.newEdition).toBe(1);

    // Compile was called with { program: "hello" }
    expect(getCompileCalled()).toBe(true);
    expect(getCompileArgs()!["program"]).toBe("hello");

    // broadcastTransaction received the mock upgrade tx bytes
    const broadcastCalls = fakeNetwork.getCallsTo("broadcastTransaction");
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0]!.args[0]).toBe("mock-upgrade-tx-bytes");

    // Confirmation was awaited
    const confirmCalls = fakeNetwork.getCallsTo("waitForConfirmation");
    expect(confirmCalls).toHaveLength(1);

    // Deploy manifest updated with incremented edition
    const manifest = readDeployManifest(artifactsDir, "hello.aleo");
    expect(manifest).not.toBeNull();
    expect(manifest!.edition).toBe(1);
    expect(manifest!.txId).toBe(result.txId);
  });

  it("rejects upgrade of @noupgrade program", async () => {
    const { lre } = createUpgradeFixture({ constructorType: "noupgrade" });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "@noupgrade",
    );
    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      DeployError,
    );
  });

  it("rejects upgrade when new ABI is not compatible (mapping removed)", async () => {
    const { lre } = createUpgradeFixture({
      oldMappings: ["counters", "scores"],
      newMappings: ["counters"], // "scores" mapping removed
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      UpgradeCompatibilityError,
    );
  });

  it("throws DeployError when confirmation returns rejected status", async () => {
    const { lre, fakeNetwork } = createUpgradeFixture();

    fakeNetwork.setConfirmBehavior("reject");

    await expect(
      upgradeAction({ program: "hello" }, lre),
    ).rejects.toThrow(DeployError);
  });

  it("skips confirmation when skipConfirm is true", async () => {
    const { lre, fakeNetwork } = createUpgradeFixture();

    await upgradeAction({ program: "hello", skipConfirm: true }, lre);

    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
  });

  it("throws when no deploy manifest exists", async () => {
    const { lre } = createUpgradeFixture({ skipManifest: true });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "No deploy manifest found",
    );
  });

  it("increments edition in deploy manifest", async () => {
    const { lre, artifactsDir } = createUpgradeFixture({ edition: 2 });

    const result = await upgradeAction({ program: "hello" }, lre);

    expect(result.newEdition).toBe(3);

    const manifest = readDeployManifest(artifactsDir, "hello.aleo");
    expect(manifest!.edition).toBe(3);
  });
});
