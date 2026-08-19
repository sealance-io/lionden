/**
 * Tier 2 contract test — crosses: @lionden/plugin-deploy + @lionden/core + @lionden/network
 *
 * The deploy orchestration driven end to end with the **Leo** backend selected:
 * real provider selection, real compatibility check, real version gate, real
 * argv assembly, real package staleness checks and real outcome parsing. Only
 * the process boundary is faked, the same way the SDK-backed contract test
 * fakes `createSdkObjects`.
 *
 * The SDK-backed contract test covers pending markers, records, broadcast and
 * hooks for `sdk` only; none of that is shared code below `deployAction`, so
 * "the SDK path works" says nothing about whether the Leo path writes a pending
 * marker before broadcasting, records the right transaction, or fires the
 * deployment hook. That gap is what this file closes.
 */

import fs from "node:fs";
import path from "node:path";
import type { LionDenPlugin, ProgramDeployedContext } from "@lionden/core";
import type { ProgramABI } from "@lionden/leo-compiler";
import type { NetworkManager } from "@lionden/network";
import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLeoCli, fakeDeploymentTransaction } from "./deploy-backend/leo/fake-leo-cli.js";
import type { LeoRunner } from "./deploy-backend/leo/runner.js";
import { clearLeoVersionGateMemoForTests } from "./deploy-backend/leo/version-gate.js";
import { type DeployTaskResult, deployAction } from "./deploy-task.js";
import { DeploymentManagerImpl } from "./deployment-manager.js";
import { readPendingMarker } from "./deployment-state.js";
import { upgradeAction } from "./upgrade-task.js";

/**
 * The one seam: `spawnLeoRunner`. Everything between `deployAction` and the
 * `spawn()` call is the real implementation, so provider selection, the
 * compatibility check, argv assembly, the `--save` directory and outcome
 * parsing are all exercised rather than stubbed.
 */
const activeRunner = vi.hoisted(() => ({ current: undefined as LeoRunner | undefined }));

vi.mock("./deploy-backend/leo/runner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./deploy-backend/leo/runner.js")>();
  return {
    ...original,
    spawnLeoRunner: (request: Parameters<LeoRunner>[0]) => {
      if (!activeRunner.current) throw new Error("no fake Leo CLI installed for this test");
      return activeRunner.current(request);
    },
  };
});

const PROGRAM = "hello.aleo";
const DEVNODE_ACCOUNT_0 = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";
const ALEO_SOURCE = `program hello.aleo;\n\nfunction main:\n    input r0 as u32.private;\n    output r0 as u32.private;\n`;

function makeAbi(programId = PROGRAM): ProgramABI {
  return {
    program: programId,
    transitions: [{ name: "main", inputs: [], outputs: [], is_async: false }],
    structs: [],
    records: [],
    mappings: [],
    storage_variables: [],
  };
}

function unwrapDeploy(result: DeployTaskResult) {
  if (result.mode !== "deploy") throw new Error(`Expected deploy mode, got: ${result.mode}`);
  return result.results;
}

describe("Leo deploy backend orchestration contract", () => {
  let fixture: ContractLreResult;

  beforeEach(() => {
    delete process.env["LIONDEN_PROVE"];
    delete process.env["LIONDEN_DEPLOY_BACKEND"];
    activeRunner.current = undefined;
    clearLeoVersionGateMemoForTests();
  });

  afterEach(() => {
    fixture?.cleanup();
    activeRunner.current = undefined;
    clearLeoVersionGateMemoForTests();
    vi.restoreAllMocks();
  });

  /**
   * A stand-in for the `leo` binary that answers `--version` and nothing else.
   *
   * The version gate is deliberately not mocked: it spawns the configured
   * binary, and a test that skipped it would not be exercising the real step-0
   * path. Answering truthfully is enough, since the gate only reads the version
   * line and the deploy itself goes through the faked runner.
   */
  function writeLeoShim(root: string): string {
    const shim = path.join(root, "leo-shim.sh");
    fs.writeFileSync(shim, '#!/bin/sh\necho "leo 4.3.2 (60bbdef HEAD) features=[noconfig]"\n');
    fs.chmodSync(shim, 0o755);
    return shim;
  }

  /**
   * The materialized Leo package `leo deploy --path` is pointed at, laid out the
   * way `materializePackage` leaves it. `resolveLeoPackage` hashes the built
   * `.aleo` and compares it to what lionden recorded, so both have to exist and
   * agree or the run is refused before Leo is ever spawned.
   */
  function writeLeoPackage(artifactsDir: string, programId: string, aleo: string): void {
    const buildDir = path.join(artifactsDir, ".build", programId, "build", programId);
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.aleo"), aleo);

    const recordedDir = path.join(artifactsDir, programId);
    fs.mkdirSync(recordedDir, { recursive: true });
    fs.writeFileSync(path.join(recordedDir, "main.aleo"), aleo);
  }

  interface LeoFixtureOptions {
    /** Select the backend through config rather than a CLI flag. */
    readonly backendInConfig?: boolean;
    /** Keep deployment state on disk, so pending markers are observable. */
    readonly diskBacked?: boolean;
  }

  function createLeoFixture(options: LeoFixtureOptions = {}) {
    /** Every observable side effect, in the order it happened. */
    const order: string[] = [];
    const hookCalls: ProgramDeployedContext[] = [];

    const hookPlugin: LionDenPlugin = {
      id: "test-deployment-hook",
      hookHandlers: {
        deployment: {
          programDeployed(ctx) {
            order.push("hook");
            hookCalls.push(ctx);
          },
        },
      },
    };

    fixture = createContractLre({
      programs: [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      plugins: [hookPlugin],
      withNetwork: true,
      withMockCompile: true,
      configOverrides: { leoVersion: "4.3.2" },
      prePopulateArtifacts: [{ programId: PROGRAM, abi: makeAbi(), aleoSource: ALEO_SOURCE }],
    });

    const { lre, fakeNetwork, project } = fixture;
    const config = lre.config as unknown as Record<string, unknown>;
    config["leoBinary"] = writeLeoShim(project.root);
    if (options.backendInConfig) {
      config["deploy"] = { ...lre.config.deploy, backend: "leo" };
    }
    if (options.diskBacked) {
      (lre.config.networks["devnode"] as { ephemeral?: boolean }).ephemeral = false;
    }

    writeLeoPackage(project.artifactsDir, PROGRAM, ALEO_SOURCE);

    const manager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );
    (lre as unknown as Record<string, unknown>)["deployments"] = manager;

    const setPending = manager.setPending.bind(manager);
    vi.spyOn(manager, "setPending").mockImplementation(async (pending) => {
      order.push("pending");
      return setPending(pending);
    });

    const broadcast = fakeNetwork!.broadcastTransaction.bind(fakeNetwork!);
    vi.spyOn(fakeNetwork!, "broadcastTransaction").mockImplementation(async (transaction) => {
      order.push("broadcast");
      fakeNetwork!.setProgramSource(PROGRAM, ALEO_SOURCE);
      fakeNetwork!.setProgramEdition(PROGRAM, 0);
      return broadcast(transaction);
    });

    const record = manager.record.bind(manager);
    vi.spyOn(manager, "record").mockImplementation(async (rec, action, extra) => {
      order.push("record");
      return record(rec, action, extra);
    });

    /**
     * Put the program on-chain with a complete deployment record, so an
     * `upgrade` has everything it needs to run to completion.
     *
     * Without this the upgrade would fail at "no deployment record found" and
     * the no-side-effect assertions would hold for the wrong reason.
     */
    async function seedPriorDeployment(): Promise<void> {
      await manager.record(
        {
          status: "complete",
          programId: PROGRAM,
          network: "devnode",
          endpoint: "http://127.0.0.1:3030",
          txId: "at1original",
          blockHeight: 1,
          deployerAddress: DEVNODE_ACCOUNT_0,
          deployedAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          edition: 1,
          historyCount: 1,
        },
        "deploy",
        { abi: makeAbi() },
      );
      fakeNetwork!.setProgramSource(PROGRAM, ALEO_SOURCE);
      fakeNetwork!.setProgramEdition(PROGRAM, 1);
      // Only the deploy-path calls are of interest from here on.
      order.length = 0;
    }

    return {
      lre,
      manager,
      fakeNetwork: fakeNetwork!,
      artifactsDir: project.artifactsDir,
      deploymentsDir: lre.config.paths.deployments,
      order,
      hookCalls,
      seedPriorDeployment,
    };
  }

  /** Install a fake Leo CLI for the run and return it for argv assertions. */
  function installLeo(options: ConstructorParameters<typeof FakeLeoCli>[0] = {}): FakeLeoCli {
    const fake = new FakeLeoCli(options);
    activeRunner.current = fake.runner;
    return fake;
  }

  describe("the deploy axis", () => {
    it("deploys through the Leo backend and broadcasts exactly what Leo built", async () => {
      const { lre, fakeNetwork } = createLeoFixture();
      const transaction = fakeDeploymentTransaction(PROGRAM, { id: "at1leobuilt" });
      const fake = installLeo({ savedTransactions: { [PROGRAM]: transaction } });

      const results = unwrapDeploy(
        await deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre),
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.programId).toBe(PROGRAM);

      // Leo ran once, in build-only mode.
      expect(fake.onlyCall.argv[1]).toBe("deploy");
      expect(fake.onlyCall.argv).toContain("--save");
      expect(fake.onlyCall.argv).not.toContain("--broadcast");

      // lionden broadcast it — byte for byte, not a re-serialization.
      const broadcasts = fakeNetwork.getCallsTo("broadcastTransaction");
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.args[0]).toBe(transaction);
    });

    it("selects the Leo backend from config, not only from the CLI flag", async () => {
      const { lre } = createLeoFixture({ backendInConfig: true });
      const fake = installLeo({
        savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) },
      });

      await deployAction({ program: "hello", noCompile: true }, lre);

      expect(fake.calls).toHaveLength(1);
    });

    /**
     * The ordering that makes a crashed deploy recoverable: the pending marker
     * has to be on disk before the transaction is in flight, or a process that
     * dies mid-broadcast leaves a deployment nobody knows to reconcile.
     */
    it("writes the pending marker before broadcasting, and records after confirming", async () => {
      const { lre, order } = createLeoFixture();
      installLeo({ savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) } });

      await deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre);

      expect(order).toEqual(["pending", "broadcast", "record", "hook"]);
    });

    it("writes a complete deployment record for the program Leo built", async () => {
      const { lre, manager } = createLeoFixture();
      installLeo({ savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) } });

      const results = unwrapDeploy(
        await deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre),
      );

      const record = manager.getCached(PROGRAM, "devnode");
      expect(record).toMatchObject({
        status: "complete",
        programId: PROGRAM,
        network: "devnode",
        txId: results[0]!.txId,
        edition: 0,
      });
    });

    it("clears the pending marker once the deployment is recorded", async () => {
      const { lre, deploymentsDir } = createLeoFixture({ diskBacked: true });
      installLeo({ savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) } });

      await deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre);

      expect(readPendingMarker(deploymentsDir, "devnode", PROGRAM)).toBeNull();
    });

    it("fires the deployment hook with the broadcast transaction's id", async () => {
      const { lre, hookCalls } = createLeoFixture();
      installLeo({ savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) } });

      const results = unwrapDeploy(
        await deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre),
      );

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]).toMatchObject({
        programId: PROGRAM,
        txId: results[0]!.txId,
        network: "devnode",
      });
    });

    it("awaits confirmation of the transaction lionden broadcast", async () => {
      const { lre, fakeNetwork } = createLeoFixture();
      installLeo({ savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) } });

      const results = unwrapDeploy(
        await deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre),
      );

      const confirms = fakeNetwork.getCallsTo("waitForConfirmation");
      expect(confirms).toHaveLength(1);
      expect(confirms[0]!.args[0]).toBe(results[0]!.txId);
    });

    /**
     * A Leo failure has to surface as a failed deploy, not a recorded one. The
     * pending marker is expected to survive — that is what
     * `recoverPendingDeployments` reconciles on the next run — but no record and
     * no hook may fire.
     */
    it("records nothing when Leo fails", async () => {
      const { lre, manager, order, hookCalls } = createLeoFixture({ diskBacked: true });
      installLeo({ exitCode: 213, stderr: "Failed to get consensus version" });

      await expect(
        deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre),
      ).rejects.toThrow(/exit code 213/);

      expect(order).toEqual(["pending"]);
      expect(hookCalls).toEqual([]);
      expect(manager.getCached(PROGRAM, "devnode")).toBeNull();
    });

    /**
     * `leo deploy --path` recompiles from `src/` when it is newer than `build/`.
     * If it does, the transaction it built is not the artifact lionden recorded,
     * so the run must abort before broadcast rather than record bytecode that
     * was never compiled here.
     */
    it("aborts before broadcast when Leo rebuilds the program mid-run", async () => {
      const { lre, artifactsDir, order } = createLeoFixture();
      installLeo({
        savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) },
        onRun: () => {
          const built = path.join(artifactsDir, ".build", PROGRAM, "build", PROGRAM, "main.aleo");
          fs.writeFileSync(built, `${ALEO_SOURCE}\nfunction extra:\n`);
        },
      });

      await expect(
        deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre),
      ).rejects.toThrow(/rebuilt "hello\.aleo" during the run/);

      expect(order).toEqual(["pending"]);
    });

    it("rejects before spawning Leo when the binary is on an unsupported line", async () => {
      const { lre, order } = createLeoFixture();
      const fake = installLeo({
        savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) },
      });
      const shim = lre.config.leoBinary;
      fs.writeFileSync(shim, '#!/bin/sh\necho "leo 4.1.0 (abc1234 HEAD)"\n');

      await expect(
        deployAction({ program: "hello", deployBackend: "leo", noCompile: true }, lre),
      ).rejects.toThrow(/supports Leo 4\.3\.x only/);

      // Step 0: nothing happened at all.
      expect(fake.calls).toHaveLength(0);
      expect(order).toEqual([]);
    });
  });

  /**
   * TEMPORARY — replaced by the positive upgrade axis in the PR that implements
   * `buildUpgrade`. Until then the guarantee under test is that the rejection
   * happens at step 0, before `upgradeAction` connects, compiles, or writes a
   * pending upgrade marker. On a non-ephemeral network a marker written here
   * would outlive the failed command as a record of an upgrade that never
   * started, and the next run would try to reconcile it.
   */
  describe("upgrade is refused before it can leave a trace", () => {
    it("rejects without connecting, compiling, or writing state", async () => {
      const { lre, manager, deploymentsDir, order, seedPriorDeployment } = createLeoFixture({
        diskBacked: true,
        backendInConfig: true,
      });
      // Everything an upgrade needs is in place, so nothing else can be the
      // reason it stops: on-chain program, complete record, compile task,
      // compiled artifacts.
      await seedPriorDeployment();
      const before = manager.getCached(PROGRAM, "devnode");
      const fake = installLeo();

      const connect = vi.spyOn(lre.network as NetworkManager, "connect");
      const runTask = vi.spyOn(lre.tasks, "run");

      await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
        /cannot run `upgrade` yet/,
      );

      expect(connect).not.toHaveBeenCalled();
      expect(runTask).not.toHaveBeenCalled();
      expect(fake.calls).toHaveLength(0);
      expect(order).toEqual([]);
      // No pending upgrade marker for the next run to reconcile, and the
      // existing record is exactly as it was.
      expect(readPendingMarker(deploymentsDir, "devnode", PROGRAM)).toBeNull();
      expect(manager.getCached(PROGRAM, "devnode")).toEqual(before);
    });

    it("points at the SDK backend, which can still upgrade", async () => {
      const { lre } = createLeoFixture({ backendInConfig: true });
      installLeo();

      await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(
        /--deploy-backend sdk/,
      );
    });

    /**
     * The flag is read at the same point as the config value, so an
     * `--deploy-backend leo` on an otherwise SDK-configured project must be
     * refused just as early.
     */
    it("refuses a --deploy-backend leo flag on an SDK-configured project", async () => {
      const { lre } = createLeoFixture({ diskBacked: true });
      const connect = vi.spyOn(lre.network as NetworkManager, "connect");
      installLeo();

      await expect(upgradeAction({ program: "hello", deployBackend: "leo" }, lre)).rejects.toThrow(
        /cannot run `upgrade` yet/,
      );
      expect(connect).not.toHaveBeenCalled();
    });
  });
});
