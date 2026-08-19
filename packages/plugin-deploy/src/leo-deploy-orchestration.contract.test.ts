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
import { type LionDenPlugin, type ProgramDeployedContext, task } from "@lionden/core";
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
const HTTP_ENDPOINT = "https://api.explorer.provable.com/v1";
const DEVNODE_ACCOUNT_0 = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";
/**
 * The connection's signing key. Not optional decoration: the backend refuses to
 * spawn Leo without one, because Leo would otherwise resolve `PRIVATE_KEY` from
 * a `.env` on disk and sign with an identity lionden never selected. A real
 * connection always carries one.
 */
const SIGNING_KEY = "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";
const ALEO_SOURCE = `program hello.aleo;\n\nfunction main:\n    input r0 as u32.private;\n    output r0 as u32.private;\n`;
/** Effective id of the renamed upgrade target — note it contains `hello.aleo`. */
const RENAMED = "zhello.aleo";
const RENAMED_SOURCE = `program zhello.aleo;\n\nfunction main:\n    input r0 as u32.private;\n    output r0 as u32.private;\n`;

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
    /**
     * Edition the fake network reports once a transaction is broadcast. Deploy
     * expects 0; an upgrade seeded at edition 1 has to see it advance past 1 or
     * `waitForProgramEditionAdvance` never returns.
     */
    readonly editionAfterBroadcast?: number;
    /**
     * Target an HTTP network named `testnet` instead of the devnode. The
     * connection type is what decides `--devnet`, `--skip-deploy-certificate`
     * and `DEVNET`, so it has to be real here rather than assumed.
     */
    readonly http?: boolean;
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
          programUpgraded(ctx) {
            order.push("hook");
            hookCalls.push(ctx);
          },
        },
      },
    };

    const networkName = options.http ? "testnet" : "devnode";

    fixture = createContractLre({
      programs: [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      plugins: [hookPlugin],
      withNetwork: options.http
        ? { type: "http", name: networkName, endpoint: HTTP_ENDPOINT, privateKey: SIGNING_KEY }
        : { privateKey: SIGNING_KEY },
      knownNetworks: [networkName],
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
    if (options.http) {
      // `buildPreflightContext` reads the *config* entry, not the connection, so
      // both have to agree or step 0 would gate on a devnode it never targets.
      (lre.config.networks as Record<string, unknown>)[networkName] = {
        type: "http",
        endpoint: HTTP_ENDPOINT,
        network: "testnet",
        ephemeral: false,
      };
    }
    if (options.diskBacked) {
      (lre.config.networks[networkName] as { ephemeral?: boolean }).ephemeral = false;
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
      fakeNetwork!.setProgramEdition(PROGRAM, options.editionAfterBroadcast ?? 0);
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
          network: networkName,
          endpoint: fakeNetwork!.endpoint,
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
      // Only the calls made by the command under test are of interest from here.
      order.length = 0;
    }

    return {
      lre,
      manager,
      networkName,
      fakeNetwork: fakeNetwork!,
      artifactsDir: project.artifactsDir,
      deploymentsDir: lre.config.paths.deployments,
      order,
      hookCalls,
      seedPriorDeployment,
    };
  }

  /**
   * A renamed upgrade with one local dependency.
   *
   * Three ids are in play and each has exactly one job: `hello.aleo` is the
   * source (graph traversal root, and the id subtracted from the closure),
   * `zhello.aleo` is the effective id (package directory, collision check,
   * outcome identity), and `dep.aleo` is the only thing that should reach
   * `--skip`. `zhello.aleo` contains `hello.aleo`, which is what makes getting
   * the subtraction wrong fatal rather than merely untidy.
   */
  function createRenamedFixture() {
    const compilePlugin: LionDenPlugin = {
      id: "test-compile-renamed",
      tasks: [
        task("compile", "Test compile")
          .setAction(async (_args, taskLre) => {
            taskLre.artifacts.setAbi(RENAMED, makeAbi(RENAMED));
            taskLre.artifacts.setAleoSource(RENAMED, RENAMED_SOURCE);
          })
          .build(),
      ],
    };

    fixture = createContractLre({
      programs: [
        { name: "dep", annotation: "@noupgrade\n    constructor() {}" },
        { name: "hello", imports: ["dep.aleo"], annotation: "@noupgrade\n    constructor() {}" },
      ],
      plugins: [compilePlugin],
      withNetwork: { privateKey: SIGNING_KEY },
      configOverrides: { leoVersion: "4.3.2" },
      prePopulateArtifacts: [
        { programId: RENAMED, abi: makeAbi(RENAMED), aleoSource: RENAMED_SOURCE },
      ],
    });

    const { lre, fakeNetwork, project } = fixture;
    const config = lre.config as unknown as Record<string, unknown>;
    config["leoBinary"] = writeLeoShim(project.root);
    config["deploy"] = { ...lre.config.deploy, backend: "leo" };

    writeLeoPackage(project.artifactsDir, RENAMED, RENAMED_SOURCE);

    const manager = new DeploymentManagerImpl(
      lre.config,
      () => lre.network as NetworkManager | null,
      lre.artifacts,
    );
    (lre as unknown as Record<string, unknown>)["deployments"] = manager;

    const broadcast = fakeNetwork!.broadcastTransaction.bind(fakeNetwork!);
    vi.spyOn(fakeNetwork!, "broadcastTransaction").mockImplementation(async (transaction) => {
      fakeNetwork!.setProgramEdition(RENAMED, 2);
      return broadcast(transaction);
    });

    /** The prior renamed deployment the upgrade builds on. */
    async function seedRenamed(): Promise<void> {
      await manager.record(
        {
          status: "complete",
          programId: RENAMED,
          sourceProgramId: PROGRAM,
          network: "devnode",
          endpoint: fakeNetwork!.endpoint,
          txId: "at1original",
          blockHeight: 1,
          deployerAddress: DEVNODE_ACCOUNT_0,
          deployedAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          edition: 1,
          historyCount: 1,
        },
        "deploy",
        { abi: makeAbi(RENAMED) },
      );
      fakeNetwork!.setProgramSource(RENAMED, RENAMED_SOURCE);
      fakeNetwork!.setProgramEdition(RENAMED, 1);
    }

    return { lre, manager, artifactsDir: project.artifactsDir, seedRenamed };
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
   * The upgrade axis. `upgradeAction` shares no code below `deployAction` — it
   * has its own signer resolution, its own pending marker shape, its own edition
   * bookkeeping and its own hook — so none of the guarantees above carry over.
   */
  describe("the upgrade axis", () => {
    /** Everything an upgrade needs, on a Leo-configured project. */
    function upgradeFixture(over: LeoFixtureOptions = {}) {
      return createLeoFixture({
        backendInConfig: true,
        diskBacked: true,
        editionAfterBroadcast: 2,
        ...over,
      });
    }

    it("upgrades through the Leo backend and broadcasts exactly what Leo built", async () => {
      const { lre, fakeNetwork, seedPriorDeployment } = upgradeFixture();
      await seedPriorDeployment();
      const transaction = fakeDeploymentTransaction(PROGRAM, { id: "at1leoupgrade", edition: 2 });
      const fake = installLeo({ savedTransactions: { [PROGRAM]: transaction } });

      const result = await upgradeAction({ program: "hello" }, lre);

      expect(result.programId).toBe(PROGRAM);
      expect(fake.onlyCall.argv[1]).toBe("upgrade");
      expect(fake.onlyCall.argv).toContain("--save");
      expect(fake.onlyCall.argv).not.toContain("--broadcast");

      const broadcasts = fakeNetwork.getCallsTo("broadcastTransaction");
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.args[0]).toBe(transaction);
    });

    /**
     * Same invariant as deploy, and it matters more here: an upgrade that dies
     * between broadcast and record leaves a program on-chain at an edition the
     * local record does not know about.
     */
    it("writes the pending marker before broadcasting, and records after", async () => {
      const { lre, order, seedPriorDeployment } = upgradeFixture();
      await seedPriorDeployment();
      installLeo({ savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) } });

      await upgradeAction({ program: "hello" }, lre);

      expect(order[0]).toBe("pending");
      expect(order.indexOf("broadcast")).toBeLessThan(order.indexOf("record"));
      expect(order.indexOf("record")).toBeLessThan(order.indexOf("hook"));
    });

    it("records the advanced edition and clears the pending marker", async () => {
      const { lre, manager, deploymentsDir, seedPriorDeployment } = upgradeFixture();
      await seedPriorDeployment();
      installLeo({ savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) } });

      const result = await upgradeAction({ program: "hello" }, lre);

      expect(manager.getCached(PROGRAM, "devnode")).toMatchObject({
        status: "complete",
        programId: PROGRAM,
        txId: result.txId,
        // Seeded at 1; the fake network reports 2 once the upgrade is broadcast.
        edition: 2,
        historyCount: 2,
      });
      expect(readPendingMarker(deploymentsDir, "devnode", PROGRAM)).toBeNull();
    });

    it("fires the upgrade hook with the broadcast transaction's id", async () => {
      const { lre, hookCalls, seedPriorDeployment } = upgradeFixture();
      await seedPriorDeployment();
      installLeo({ savedTransactions: { [PROGRAM]: fakeDeploymentTransaction(PROGRAM) } });

      const result = await upgradeAction({ program: "hello" }, lre);

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]).toMatchObject({ programId: PROGRAM, txId: result.txId });
    });

    /**
     * The pending marker survives a Leo failure on purpose —
     * `recoverPendingDeployments` reconciles it on the next run — but the record
     * must still say the program is at its old edition.
     */
    it("records nothing when Leo fails", async () => {
      const { lre, manager, order, hookCalls, seedPriorDeployment } = upgradeFixture();
      await seedPriorDeployment();
      installLeo({ exitCode: 213, stderr: "Failed to get consensus version" });

      await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(/exit code 213/);

      expect(order).toEqual(["pending"]);
      expect(hookCalls).toEqual([]);
      expect(manager.getCached(PROGRAM, "devnode")).toMatchObject({ edition: 1, historyCount: 1 });
    });

    /**
     * The rename sharp edge, end to end.
     *
     * `zhello.aleo` contains `hello.aleo` as a substring and Leo matches `--skip`
     * by substring, so if the closure were subtracted by the *effective* id the
     * source id would survive in the skip list and Leo would skip the very
     * program being upgraded — exiting 0 with nothing saved.
     */
    it("skips a renamed upgrade's dependency and not its source id", async () => {
      const { lre, artifactsDir, seedRenamed } = createRenamedFixture();
      await seedRenamed();
      const fake = installLeo({
        savedTransactions: { [RENAMED]: fakeDeploymentTransaction(RENAMED) },
      });

      await upgradeAction({ program: "zhello" }, lre);

      const argv = fake.onlyCall.argv;
      const skips = argv.filter((_arg, i) => argv[i - 1] === "--skip");
      expect(skips).toEqual(["dep.aleo"]);
      // The package Leo was pointed at is the post-rename one, and `--rename` is
      // never passed: `materializePackage` already rewrote the declaration.
      expect(argv[argv.indexOf("--path") + 1]).toBe(path.join(artifactsDir, ".build", RENAMED));
      expect(argv).not.toContain("--rename");
    });
  });

  /**
   * The HTTP axis. Two flags and one environment variable are unsafe against a
   * live network, and all three are decided by the connection type — so the
   * connection here is genuinely HTTP rather than a devnode with a different
   * name.
   */
  describe("the HTTP axis", () => {
    it("deploys to an HTTP network without devnode-only flags", async () => {
      const { lre, fakeNetwork } = createLeoFixture({ http: true });
      const transaction = fakeDeploymentTransaction(PROGRAM, { id: "at1httpbuilt" });
      const fake = installLeo({ savedTransactions: { [PROGRAM]: transaction } });

      await deployAction(
        { program: "hello", network: "testnet", deployBackend: "leo", noCompile: true },
        lre,
      );

      const argv = fake.onlyCall.argv;
      expect(argv).not.toContain("--devnet");
      expect(argv).not.toContain("--skip-deploy-certificate");
      expect(argv[argv.indexOf("--endpoint") + 1]).toBe(HTTP_ENDPOINT);
      expect(fake.onlyCall.env["DEVNET"]).toBe("false");
      expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(transaction);
    });

    /**
     * The reason HTTP dry-run had to wait for this PR: the gate keys on
     * `capabilities.buildWithoutBroadcast`, which is unconditionally true for
     * the Leo backend, so admitting it before `DEVNET=false` and the
     * `buildDotEnv` fix would have run a live-network invocation inside a
     * package carrying a real key.
     */
    it("dry-runs against an HTTP network, building without broadcasting", async () => {
      const { lre, fakeNetwork, manager, deploymentsDir, order } = createLeoFixture({
        http: true,
        diskBacked: true,
      });
      const transaction = fakeDeploymentTransaction(PROGRAM, { id: "at1httpdryrun" });
      const fake = installLeo({ savedTransactions: { [PROGRAM]: transaction } });

      const result = await deployAction(
        {
          program: "hello",
          network: "testnet",
          deployBackend: "leo",
          noCompile: true,
          dryRun: true,
        },
        lre,
      );

      if (result.mode !== "dry-run") throw new Error(`Expected dry-run mode, got: ${result.mode}`);
      expect(result.results[0]!.transaction).toBe(transaction);

      // Leo ran, and nothing else did.
      expect(fake.onlyCall.argv).not.toContain("--broadcast");
      expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
      expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);
      expect(order).toEqual([]);
      expect(manager.getCached(PROGRAM, "testnet")).toBeNull();
      expect(readPendingMarker(deploymentsDir, "testnet", PROGRAM)).toBeNull();
    });

    it("upgrades against an HTTP network", async () => {
      const { lre, fakeNetwork, seedPriorDeployment } = createLeoFixture({
        http: true,
        diskBacked: true,
        backendInConfig: true,
        editionAfterBroadcast: 2,
      });
      await seedPriorDeployment();
      const transaction = fakeDeploymentTransaction(PROGRAM, { id: "at1httpupgrade", edition: 2 });
      const fake = installLeo({ savedTransactions: { [PROGRAM]: transaction } });

      await upgradeAction({ program: "hello", network: "testnet" }, lre);

      expect(fake.onlyCall.argv[1]).toBe("upgrade");
      expect(fake.onlyCall.argv).not.toContain("--devnet");
      expect(fake.onlyCall.argv).not.toContain("--skip-deploy-certificate");
      expect(fake.onlyCall.env["DEVNET"]).toBe("false");
      expect(fakeNetwork.getCallsTo("broadcastTransaction")[0]!.args[0]).toBe(transaction);
    });
  });
});
