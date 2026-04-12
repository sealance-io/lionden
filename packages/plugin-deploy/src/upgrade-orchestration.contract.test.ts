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
import { extractConstructorFingerprint } from "./constructor-parser.js";

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
    constructorType?: "admin" | "noupgrade" | "checksum" | "custom";
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
    /** Compiled Aleo source for the deployed (old) version */
    oldAleoSource?: string;
    /** Compiled Aleo source that compile produces for the new version */
    newAleoSource?: string;
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
    const newAbi = makeAbi({ mappings: newMappings });
    const defaultAleoSource =
      `program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n`;
    const aleoSource = opts?.newAleoSource ?? opts?.oldAleoSource ?? defaultAleoSource;
    const oldAleoSource = opts?.oldAleoSource ?? defaultAleoSource;

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

    // Write old ABI and compiled source to disk
    // (readOldAbi/readOldAleoSource read from filesystem, not lre.artifacts)
    if (!opts?.skipOldAbi) {
      const abiDir = path.join(artifactsDir, "hello.aleo");
      fs.mkdirSync(abiDir, { recursive: true });
      fs.writeFileSync(
        path.join(abiDir, "abi.json"),
        JSON.stringify(oldAbi, null, 2),
      );
      fs.writeFileSync(
        path.join(abiDir, "main.aleo"),
        oldAleoSource,
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
        checksumMapping:
          constructorType === "checksum" ? "gov.aleo::checksums" : null,
        checksumKey:
          constructorType === "checksum" ? "hello" : null,
        constructorFingerprint: extractConstructorFingerprint(oldAleoSource, constructorType),
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

  it("throws when old ABI artifact is missing", async () => {
    const { lre } = createUpgradeFixture({ skipOldAbi: true });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "No ABI artifact found",
    );
  });

  it("throws when old source artifact is missing and manifest has no fingerprint", async () => {
    // Create fixture manually to control which files exist on disk
    fixture = createContractLre({
      programs: [{ name: "hello", annotation: `@admin(address="${DEVNODE_ACCOUNT_0}")\n    constructor() {}` }],
      plugins: [{
        id: "test-compile",
        tasks: [
          task("compile", "Test compile")
            .setAction(async (_args, lre) => {
              lre.artifacts.setAbi("hello.aleo", makeAbi());
              lre.artifacts.setAleoSource("hello.aleo",
                "program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n");
            })
            .build(),
        ],
      }],
      withNetwork: true,
      prePopulateArtifacts: [{ programId: "hello.aleo", abi: makeAbi(), aleoSource: "" }],
    });

    const { lre, project } = fixture;
    const artifactsDir = project.artifactsDir;

    // Write ABI but NOT main.aleo
    const abiDir = path.join(artifactsDir, "hello.aleo");
    fs.mkdirSync(abiDir, { recursive: true });
    fs.writeFileSync(path.join(abiDir, "abi.json"), JSON.stringify(makeAbi(), null, 2));

    // Manifest WITHOUT constructorFingerprint (old deploy)
    writeDeployManifest(artifactsDir, {
      programId: "hello.aleo",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      txId: "at1original",
      blockHeight: 1,
      edition: 0,
      constructorType: "admin",
      constructorAdmin: DEVNODE_ACCOUNT_0,
      // No constructorFingerprint
      deployedAt: "2026-04-01T00:00:00.000Z",
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "No compiled source artifact found",
    );
  });

  it("rejects upgrade when constructor type changes", async () => {
    const { lre } = createUpgradeFixture({
      constructorType: "admin",
      sourceAnnotation: "@noupgrade\n    constructor() {}",
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "constructor type changed",
    );
  });

  it("rejects upgrade when admin address changes", async () => {
    const { lre } = createUpgradeFixture({
      constructorType: "admin",
      sourceAnnotation:
        '@admin(address="aleo1qnr4dkkvkgfqph0vzc3y6z2eu975wnpz2925ntjccd5cfqxtyu8s7pyjh9")\n    constructor() {}',
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "admin address changed",
    );
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

    const { lre } = createUpgradeFixture({
      constructorType: "custom",
      sourceAnnotation: "@custom\n    constructor() {}",
      oldAleoSource: oldSource,
      newAleoSource: newSource,
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "constructor body changed",
    );
  });

  it("rejects @custom upgrade when only edition assertion changes", async () => {
    // For @custom, edition assertions are user-authored logic — changes must be caught
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
      "    call governance.aleo/check_vote into r0;",
      "    assert.eq r0 true;",
      "    assert.eq edition 1u16;",
      "",
    ].join("\n");

    const { lre } = createUpgradeFixture({
      constructorType: "custom",
      sourceAnnotation: "@custom\n    constructor() {}",
      oldAleoSource: oldSource,
      newAleoSource: newSource,
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "constructor body changed",
    );
  });

  it("backfills fingerprint from old artifact when manifest has no fingerprint", async () => {
    // Simulates upgrading a program deployed before fingerprinting was added.
    // The old compiled source is on disk; the manifest has no constructorFingerprint.
    const oldSource = [
      "program hello.aleo;",
      "function main:",
      "  input r0 as u32.private;",
      "  output r0 as u32.private;",
      "",
      "constructor:",
      "    assert.eq self.signer " + DEVNODE_ACCOUNT_0 + ";",
      "    assert.eq edition 0u16;",
      "",
    ].join("\n");

    // New source has same constructor logic — should pass
    const newSource = [
      "program hello.aleo;",
      "function main:",
      "  input r0 as u32.private;",
      "  output r0 as u32.private;",
      "",
      "constructor:",
      "    assert.eq self.signer " + DEVNODE_ACCOUNT_0 + ";",
      "    assert.eq edition 1u16;",
      "",
    ].join("\n");

    fixture = createContractLre({
      programs: [{ name: "hello", annotation: `@admin(address="${DEVNODE_ACCOUNT_0}")\n    constructor() {}` }],
      plugins: [{
        id: "test-compile",
        tasks: [
          task("compile", "Test compile")
            .setAction(async (_args, lre) => {
              lre.artifacts.setAbi("hello.aleo", makeAbi());
              lre.artifacts.setAleoSource("hello.aleo", newSource);
            })
            .build(),
        ],
      }],
      withNetwork: true,
      prePopulateArtifacts: [{ programId: "hello.aleo", abi: makeAbi(), aleoSource: oldSource }],
    });

    const { lre, project } = fixture;
    const artifactsDir = project.artifactsDir;

    // Write old ABI to disk
    const abiDir = path.join(artifactsDir, "hello.aleo");
    fs.mkdirSync(abiDir, { recursive: true });
    fs.writeFileSync(path.join(abiDir, "abi.json"), JSON.stringify(makeAbi(), null, 2));

    // Write old compiled source to disk (main.aleo)
    fs.writeFileSync(path.join(abiDir, "main.aleo"), oldSource);

    // Write manifest WITHOUT constructorFingerprint (simulates old deploy)
    writeDeployManifest(artifactsDir, {
      programId: "hello.aleo",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      txId: "at1original",
      blockHeight: 1,
      edition: 0,
      constructorType: "admin",
      constructorAdmin: DEVNODE_ACCOUNT_0,
      // No constructorFingerprint — old manifest
      deployedAt: "2026-04-01T00:00:00.000Z",
    });

    // Same constructor body (just edition differs) — should succeed
    const result = await upgradeAction({ program: "hello" }, lre);
    expect(result.programId).toBe("hello.aleo");

    // After upgrade, manifest should now have the fingerprint backfilled
    const manifest = readDeployManifest(artifactsDir, "hello.aleo");
    expect(manifest!.constructorFingerprint).toBeDefined();
    expect(manifest!.constructorFingerprint).toBe(
      "assert.eq self.signer " + DEVNODE_ACCOUNT_0 + ";",
    );
  });

  it("backfill rejects body change on old manifest without fingerprint", async () => {
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

    // New source has DIFFERENT constructor body
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

    fixture = createContractLre({
      programs: [{ name: "hello", annotation: "@custom\n    constructor() {}" }],
      plugins: [{
        id: "test-compile",
        tasks: [
          task("compile", "Test compile")
            .setAction(async (_args, lre) => {
              lre.artifacts.setAbi("hello.aleo", makeAbi());
              lre.artifacts.setAleoSource("hello.aleo", newSource);
            })
            .build(),
        ],
      }],
      withNetwork: true,
      prePopulateArtifacts: [{ programId: "hello.aleo", abi: makeAbi(), aleoSource: oldSource }],
    });

    const { lre, project } = fixture;
    const artifactsDir = project.artifactsDir;

    // Write old ABI and compiled source to disk
    const abiDir = path.join(artifactsDir, "hello.aleo");
    fs.mkdirSync(abiDir, { recursive: true });
    fs.writeFileSync(path.join(abiDir, "abi.json"), JSON.stringify(makeAbi(), null, 2));
    fs.writeFileSync(path.join(abiDir, "main.aleo"), oldSource);

    // Write manifest WITHOUT constructorFingerprint
    writeDeployManifest(artifactsDir, {
      programId: "hello.aleo",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      txId: "at1original",
      blockHeight: 1,
      edition: 0,
      constructorType: "custom",
      constructorAdmin: null,
      deployedAt: "2026-04-01T00:00:00.000Z",
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "constructor body changed",
    );
  });

  it("rejects upgrade when @checksum parameters change", async () => {
    fixture = createContractLre({
      programs: [{
        name: "hello",
        annotation: '@checksum(mapping="new_gov.aleo::checksums", key="hello")\n    constructor() {}',
      }],
      plugins: [{
        id: "test-compile",
        tasks: [
          task("compile", "Test compile")
            .setAction(async (_args, lre) => {
              lre.artifacts.setAbi("hello.aleo", makeAbi());
              lre.artifacts.setAleoSource("hello.aleo",
                "program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n");
            })
            .build(),
        ],
      }],
      withNetwork: true,
      prePopulateArtifacts: [{
        programId: "hello.aleo",
        abi: makeAbi(),
        aleoSource: "program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n",
      }],
    });

    const { lre, project } = fixture;
    const artifactsDir = project.artifactsDir;

    const abiDir = path.join(artifactsDir, "hello.aleo");
    fs.mkdirSync(abiDir, { recursive: true });
    fs.writeFileSync(path.join(abiDir, "abi.json"), JSON.stringify(makeAbi(), null, 2));
    fs.writeFileSync(path.join(abiDir, "main.aleo"),
      "program hello.aleo;\nfunction main:\n  input r0 as u32.private;\n  output r0 as u32.private;\n");

    writeDeployManifest(artifactsDir, {
      programId: "hello.aleo",
      network: "devnode",
      endpoint: "http://127.0.0.1:3030",
      txId: "at1original",
      blockHeight: 1,
      edition: 0,
      constructorType: "checksum",
      constructorAdmin: null,
      checksumMapping: "old_gov.aleo::checksums",
      checksumKey: "hello",
      constructorFingerprint: "",
      deployedAt: "2026-04-01T00:00:00.000Z",
    });

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
      "@checksum parameters changed",
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
