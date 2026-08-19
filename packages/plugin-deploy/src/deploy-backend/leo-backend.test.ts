/**
 * End-to-end tests for the Leo backend, driven through a fake CLI.
 *
 * These run against a real temporary package on disk rather than a stubbed
 * filesystem, because two of the behaviours under test — locating the built
 * `.aleo` through the compiler's own probe, and detecting that Leo rewrote it
 * mid-run — are entirely about what is on disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REDACTED } from "@lionden/core";
import { loadLeoCliCapture } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeoDeployError } from "./leo/errors.js";
import { FakeLeoCli, fakeDeploymentTransaction } from "./leo/fake-leo-cli.js";
import { createLeoDeployBackend } from "./leo-backend.js";
import type { DeployBackendContext, DeployBackendRequest } from "./types.js";

const PROGRAM = "hello.aleo";
const ALEO_V1 = "program hello.aleo;\n\nfunction main:\n";
const ALEO_V2 = "program hello.aleo;\n\nfunction main:\nfunction extra:\n";
/**
 * A well-formed saved transaction for `PROGRAM`. `readLeoOutcome` parses and
 * validates what Leo saved, so an opaque placeholder would be rejected before
 * any of the behaviour under test here is reached.
 */
const TX = fakeDeploymentTransaction(PROGRAM);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-leo-backend-test-"));
  writePackage(ALEO_V1);
  writeRecorded(ALEO_V1);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const artifactsDir = (): string => path.join(root, "artifacts");
const packageBuildDir = (): string =>
  path.join(artifactsDir(), ".build", PROGRAM, "build", PROGRAM);

/** The materialized Leo package, laid out the way `materializePackage` leaves it. */
function writePackage(aleo: string): void {
  fs.mkdirSync(packageBuildDir(), { recursive: true });
  fs.writeFileSync(path.join(packageBuildDir(), "main.aleo"), aleo);
}

/** What lionden recorded at compile time. */
function writeRecorded(aleo: string): void {
  const dir = path.join(artifactsDir(), PROGRAM);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.aleo"), aleo);
}

function ctx(over: Partial<DeployBackendContext> = {}): DeployBackendContext {
  return {
    networkName: "devnode",
    connectionType: "devnode",
    networkId: "testnet",
    endpoint: "http://127.0.0.1:3030",
    leoBinary: "leo",
    leoVersion: "4.3.2",
    leo: { timeout: 1_800_000, logMode: "quiet-buffered" },
    artifactsDir: artifactsDir(),
    projectRoot: root,
    egressPolicy: {} as DeployBackendContext["egressPolicy"],
    privateKey: "APrivateKey1zkpNETWORKDEFAULTxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ...over,
  };
}

function req(over: Partial<DeployBackendRequest> = {}): DeployBackendRequest {
  return {
    programId: PROGRAM,
    aleoSource: ALEO_V1,
    localDependencyIds: [],
    priorityFee: 0,
    privateFee: false,
    prove: false,
    ...over,
  };
}

/** The `LeoDeployError` a call rejected with, typed rather than widened. */
async function rejectionOf(promise: Promise<unknown>): Promise<LeoDeployError> {
  try {
    await promise;
  } catch (error) {
    return error as LeoDeployError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function backendWith(fake: FakeLeoCli) {
  return createLeoDeployBackend({ runner: fake.runner, versionProbe: async () => "leo 4.3.2" });
}

describe("LeoDeployBackend.buildDeploy", () => {
  it("returns the saved transaction for the caller to broadcast", async () => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    const result = await backendWith(fake).buildDeploy(req(), ctx());
    expect(result).toEqual({ kind: "built", transaction: TX });
  });

  /**
   * Leo builds; lionden broadcasts. A `kind: "broadcast"` result would mean the
   * backend took broadcasting away from the orchestration that owns pending
   * markers, records and confirmation polling.
   */
  it("never broadcasts", async () => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    const result = await backendWith(fake).buildDeploy(req(), ctx());
    expect(result.kind).toBe("built");
    expect(fake.onlyCall.argv).not.toContain("--broadcast");
  });

  describe("the signing key", () => {
    it("travels in the environment, never in argv", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(req(), ctx());
      expect(fake.onlyCall.env["PRIVATE_KEY"]).toBe(ctx().privateKey);
      expect(fake.onlyCall.argv.join(" ")).not.toMatch(/APrivateKey1/);
    });

    /**
     * `req.signerPrivateKey` carries the named-role override (`deployer` for
     * deploy, `admin` for upgrade). Getting this order backwards would silently
     * sign with the network's default key instead of the configured role — a
     * deployment that succeeds under the wrong account.
     */
    it("prefers the request's named-role key over the network default", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(
        req({ signerPrivateKey: "APrivateKey1zkpROLExxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }),
        ctx(),
      );
      expect(fake.onlyCall.env["PRIVATE_KEY"]).toBe(
        "APrivateKey1zkpROLExxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      );
    });

    it("falls back to the connection key when no role key is given", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(req(), ctx());
      expect(fake.onlyCall.env["PRIVATE_KEY"]).toBe(ctx().privateKey);
    });

    it("is handed to the runner as a secret to redact", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(req({ signerPrivateKey: "APrivateKey1zkpROLE" }), ctx());
      expect(fake.onlyCall.secrets).toContain("APrivateKey1zkpROLE");
    });

    /**
     * Verified against Leo 4.3.2: with `PRIVATE_KEY` absent from the child
     * environment, Leo picks it up from a `.env` at the working directory (the
     * project root) and proceeds. So an unset variable is not "no key", it is
     * "whatever key is on disk" — and a deployment signed by an identity
     * lionden never selected succeeds under the wrong account.
     *
     * Rejecting is therefore the only safe answer, and it has to happen before
     * the spawn.
     */
    describe("when lionden has no key to select", () => {
      /** No `signerPrivateKey` on the request, no `privateKey` on the context. */
      const keyless = () => {
        const base = ctx();
        delete (base as { privateKey?: string }).privateKey;
        return base;
      };

      it.each(["deploy", "upgrade"] as const)("refuses to spawn Leo at all (%s)", async (op) => {
        const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
        const backend = backendWith(fake);
        const build = op === "deploy" ? backend.buildDeploy : backend.buildUpgrade;

        await expect(build.call(backend, req(), keyless())).rejects.toThrow(
          /has no signing key for network "devnode"/,
        );
        expect(fake.calls).toHaveLength(0);
      });

      it("explains the .env fallback and names the setting to use", async () => {
        const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
        const error = await rejectionOf(backendWith(fake).buildDeploy(req(), keyless()));

        expect(error.message).toContain("`.env`");
        expect(error.message).toContain("networks.devnode.privateKey");
        expect(error.message).toContain('"deployer"');
      });

      /** Upgrade signs as `admin`, so that is the role to point at. */
      it("names the admin role on upgrade", async () => {
        const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
        const error = await rejectionOf(backendWith(fake).buildUpgrade(req(), keyless()));
        expect(error.message).toContain('"admin"');
      });

      /** A named-role key is enough on its own — the network need not have one. */
      it("accepts a request-supplied key with no network key", async () => {
        const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
        await backendWith(fake).buildDeploy(
          req({ signerPrivateKey: "APrivateKey1zkpROLExxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }),
          keyless(),
        );
        expect(fake.onlyCall.env["PRIVATE_KEY"]).toBe(
          "APrivateKey1zkpROLExxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        );
      });
    });

    /**
     * `LeoDeployError` folds the output tail into `message`, because `bin.ts`
     * prints only `error.message` — so an unredacted tail is a key printed to
     * the terminal and into whatever captures it. The tail Leo actually prints
     * on a failing run is its plan summary, truncated key and all.
     */
    describe("never reaches the error tail", () => {
      const FAILING_STDOUT = loadLeoCliCapture("deploy-skip-all").stdout;

      it("is absent from a failed run's message", async () => {
        expect(FAILING_STDOUT).toContain("APrivateKey1zkp8CZNn3yeC...");
        const fake = new FakeLeoCli({ exitCode: 1, stdout: FAILING_STDOUT });

        const error = await rejectionOf(backendWith(fake).buildDeploy(req(), ctx()));

        expect(error).toBeInstanceOf(LeoDeployError);
        expect(error.message).toContain(REDACTED);
        expect(error.message).not.toContain("APrivateKey1");
        expect(error.message).not.toContain("zkp8CZ");
        expect(error.stderrTail).not.toContain("zkp8CZ");
        // Still useful: the surrounding Leo output survives.
        expect(error.message).toContain("Skipped Programs");
      });

      it("is absent from a timed-out run's message", async () => {
        const fake = new FakeLeoCli({ timedOut: true, stdout: FAILING_STDOUT });

        const error = await rejectionOf(backendWith(fake).buildDeploy(req(), ctx()));

        expect(error.stage).toBe("timeout");
        expect(error.message).not.toContain("zkp8CZ");
      });

      /**
       * The full network key too, not only Leo's truncated rendering — a
       * misconfigured invocation could echo it whole.
       */
      it("is absent when Leo echoes the full key", async () => {
        const full = ctx().privateKey!;
        const fake = new FakeLeoCli({ exitCode: 1, stderr: `failed signing with ${full}` });

        const error = await rejectionOf(backendWith(fake).buildDeploy(req(), ctx()));

        expect(error.message).toContain(`failed signing with ${REDACTED}`);
        expect(error.message).not.toContain(full);
      });
    });
  });

  describe("the --save directory", () => {
    it("is outside artifacts/, since a signed transaction is not a build artifact", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(req(), ctx());
      const saveDir = fake.onlyCall.argv[fake.onlyCall.argv.indexOf("--save") + 1]!;
      expect(saveDir.startsWith(os.tmpdir())).toBe(true);
      expect(saveDir).not.toContain(artifactsDir());
    });

    it("is removed after a successful run", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(req(), ctx());
      const saveDir = fake.onlyCall.argv[fake.onlyCall.argv.indexOf("--save") + 1]!;
      expect(fs.existsSync(saveDir)).toBe(false);
    });

    it("is removed after a failed run", async () => {
      const fake = new FakeLeoCli({ exitCode: 1, stderr: "boom" });
      await expect(backendWith(fake).buildDeploy(req(), ctx())).rejects.toThrow(LeoDeployError);
      const saveDir = fake.onlyCall.argv[fake.onlyCall.argv.indexOf("--save") + 1]!;
      expect(fs.existsSync(saveDir)).toBe(false);
    });
  });

  describe("package staleness", () => {
    it("rejects a missing package before spawning anything", async () => {
      fs.rmSync(path.join(artifactsDir(), ".build"), { recursive: true, force: true });
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await expect(backendWith(fake).buildDeploy(req(), ctx())).rejects.toThrow(
        /No compiled Leo package/,
      );
      expect(fake.calls).toHaveLength(0);
    });

    it("rejects a package that disagrees with the recorded artifact", async () => {
      writeRecorded(ALEO_V2);
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await expect(backendWith(fake).buildDeploy(req(), ctx())).rejects.toThrow(
        /out of step with the recorded artifact/,
      );
      expect(fake.calls).toHaveLength(0);
    });

    /**
     * The check that actually protects the invariant. `leo deploy` recompiles
     * from `src/` when `src/` is newer than `build/` — measured against the real
     * CLI — so the pre-run check can pass and Leo can still build different
     * bytecode than lionden recorded.
     */
    it("aborts when Leo rebuilt the program mid-run, before broadcasting", async () => {
      const fake = new FakeLeoCli({
        savedTransactions: { [PROGRAM]: TX },
        onRun: () => writePackage(ALEO_V2),
      });
      const error = await backendWith(fake)
        .buildDeploy(req(), ctx())
        .catch((e) => e);
      expect(error).toBeInstanceOf(LeoDeployError);
      expect(error.message).toMatch(/Leo rebuilt "hello\.aleo" during the run/);
      expect(error.message).toContain("was NOT broadcast");
    });

    it("passes when Leo left the package alone", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await expect(backendWith(fake).buildDeploy(req(), ctx())).resolves.toBeTruthy();
    });
  });

  describe("failures", () => {
    it("reports a timeout and points at Leo's resumable key cache", async () => {
      const fake = new FakeLeoCli({ timedOut: true, stderr: "..." });
      const error = await backendWith(fake)
        .buildDeploy(req(), ctx())
        .catch((e) => e);
      expect(error.stage).toBe("timeout");
      expect(error.message).toContain("deploy.leo.timeout");
      expect(error.message).toContain("~/.aleo");
    });

    it("treats exit 0 with no saved transaction as a failure", async () => {
      const fake = new FakeLeoCli({ exitCode: 0 });
      await expect(backendWith(fake).buildDeploy(req(), ctx())).rejects.toThrow(
        /wrote no transaction/,
      );
    });

    /**
     * `result.json` shares the `--save` directory with the transactions, so it
     * must not be counted as one — otherwise every successful run would look
     * like it produced two.
     */
    it("does not mistake the --json-output file for a transaction", async () => {
      const fake = new FakeLeoCli({
        savedTransactions: { [PROGRAM]: TX },
        jsonOutput: JSON.stringify({ deployments: [] }),
      });
      await expect(backendWith(fake).buildDeploy(req(), ctx())).resolves.toEqual({
        kind: "built",
        transaction: TX,
      });
    });

    it("rejects a run that saved more than one transaction", async () => {
      const fake = new FakeLeoCli({
        savedTransactions: { [PROGRAM]: TX, "dep.aleo": fakeDeploymentTransaction("dep.aleo") },
      });
      await expect(backendWith(fake).buildDeploy(req(), ctx())).rejects.toThrow(
        /produced 2 transactions instead of one/,
      );
    });
  });

  describe("argv assembly from context", () => {
    it("passes the package directory, not a cwd change", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(req(), ctx());
      const argv = fake.onlyCall.argv;
      expect(argv[argv.indexOf("--path") + 1]).toBe(path.join(artifactsDir(), ".build", PROGRAM));
      expect(fake.onlyCall.cwd).toBe(root);
    });

    it("forwards configured consensus heights", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(req(), ctx({ consensusHeights: "0,5,6" }));
      const argv = fake.onlyCall.argv;
      expect(argv[argv.indexOf("--consensus-heights") + 1]).toBe("0,5,6");
    });

    it("forwards the deploy.leo timeout and log mode to the runner", async () => {
      const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
      await backendWith(fake).buildDeploy(
        req(),
        ctx({ leo: { timeout: 60_000, logMode: "forward" } }),
      );
      expect(fake.onlyCall.timeoutMs).toBe(60_000);
      expect(fake.onlyCall.logMode).toBe("forward");
    });

    /**
     * The collision check runs inside `buildLeoArgv`, which is *after* the
     * package check — so the target's package has to exist for this to test the
     * collision rather than a missing directory.
     */
    it("rejects a --skip collision before spawning", async () => {
      const target = "zhello.aleo";
      const buildDir = path.join(artifactsDir(), ".build", target, "build", target);
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "main.aleo"), ALEO_V1);

      const fake = new FakeLeoCli({
        savedTransactions: { [target]: fakeDeploymentTransaction(target) },
      });
      await expect(
        backendWith(fake).buildDeploy(
          req({ programId: target, localDependencyIds: [PROGRAM] }),
          ctx(),
        ),
      ).rejects.toThrow(/would also suppress the program itself/);
      expect(fake.calls).toHaveLength(0);
    });
  });
});

describe("LeoDeployBackend.preflight", () => {
  it("gates on the actual binary version", async () => {
    const backend = createLeoDeployBackend({
      runner: new FakeLeoCli().runner,
      versionProbe: async () => "leo 4.1.0",
    });
    await expect(backend.preflight(ctx())).rejects.toThrow(/supports Leo 4\.3\.x only/);
  });
});

/**
 * `leo upgrade` shares `leo deploy`'s flag surface — including `--skip`, whose
 * help text differs only in the verb — so both operations run through the same
 * invocation path. What is asserted here is that the shared path really is
 * shared, and that the one thing that must differ, the subcommand, does.
 */
describe("LeoDeployBackend.buildUpgrade", () => {
  it("runs `leo upgrade` and returns the saved transaction", async () => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    const result = await backendWith(fake).buildUpgrade(req(), ctx());
    expect(fake.onlyCall.argv[1]).toBe("upgrade");
    expect(result).toEqual({ kind: "built", transaction: TX });
  });

  /**
   * The whole point of `--save` without `--broadcast`. An upgrade that
   * broadcast itself would bypass the pending marker, the edition bookkeeping
   * and `waitForProgramEditionAdvance`.
   */
  it("never broadcasts", async () => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    const result = await backendWith(fake).buildUpgrade(req(), ctx());
    expect(result.kind).toBe("built");
    expect(fake.onlyCall.argv).not.toContain("--broadcast");
  });

  /**
   * On upgrade the named-role key is `admin`, not `deployer`. Falling back to
   * the network default would sign the upgrade with an account that is probably
   * not the program's admin — and Leo's constructor check rejects it on-chain,
   * after the fee is spent.
   */
  it("signs with the admin role key from the request, through the environment", async () => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    await backendWith(fake).buildUpgrade(
      req({ signerPrivateKey: "APrivateKey1zkpADMINxxxxxxxxxxxxxxxxxxxxxxxxxxx" }),
      ctx(),
    );
    expect(fake.onlyCall.env["PRIVATE_KEY"]).toBe(
      "APrivateKey1zkpADMINxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(fake.onlyCall.argv.join(" ")).not.toMatch(/APrivateKey1/);
  });

  /**
   * `leo upgrade` upgrades the package's whole local closure by default, so
   * every dependency has to be suppressed for lionden to keep owning one
   * program per invocation.
   */
  it("suppresses the local dependency closure", async () => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    await backendWith(fake).buildUpgrade(req({ localDependencyIds: ["dep.aleo"] }), ctx());
    const argv = fake.onlyCall.argv;
    expect(argv[argv.indexOf("--skip") + 1]).toBe("dep.aleo");
  });

  /**
   * `materializePackage` already rewrote the declaration into
   * `.build/<effective-id>/`, so `--path` points at the post-rename package and
   * `--rename` would rename a second time.
   */
  it("targets the post-rename package and never passes --rename", async () => {
    const target = "renamed_hello.aleo";
    const buildDir = path.join(artifactsDir(), ".build", target, "build", target);
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.aleo"), ALEO_V1);
    fs.mkdirSync(path.join(artifactsDir(), target), { recursive: true });
    fs.writeFileSync(path.join(artifactsDir(), target, "main.aleo"), ALEO_V1);

    const fake = new FakeLeoCli({
      savedTransactions: { [target]: fakeDeploymentTransaction(target) },
    });
    await backendWith(fake).buildUpgrade(
      req({ programId: target, sourceProgramId: PROGRAM, localDependencyIds: ["dep.aleo"] }),
      ctx(),
    );

    const argv = fake.onlyCall.argv;
    expect(argv[argv.indexOf("--path") + 1]).toBe(path.join(artifactsDir(), ".build", target));
    expect(argv).not.toContain("--rename");
    // The source id must not have survived into the skip list: it is a
    // substring of the effective id, so Leo would skip the upgrade itself.
    expect(argv).not.toContain(PROGRAM);
  });

  /** Same guard as deploy: what Leo built must be what lionden recorded. */
  it("aborts when Leo rebuilt the program mid-run, before broadcasting", async () => {
    const fake = new FakeLeoCli({
      savedTransactions: { [PROGRAM]: TX },
      onRun: () => writePackage(ALEO_V2),
    });
    const error = await rejectionOf(backendWith(fake).buildUpgrade(req(), ctx()));
    expect(error.message).toMatch(/Leo rebuilt "hello\.aleo" during the run/);
    expect(error.message).toContain("was NOT broadcast");
  });

  it("names the operation in its failure messages", async () => {
    const fake = new FakeLeoCli({ timedOut: true, stderr: "..." });
    const error = await rejectionOf(backendWith(fake).buildUpgrade(req(), ctx()));
    expect(error.stage).toBe("timeout");
    expect(error.message).toContain("Leo upgrade");
  });

  it("treats exit 0 with no saved transaction as a failure", async () => {
    const fake = new FakeLeoCli({ exitCode: 0 });
    await expect(backendWith(fake).buildUpgrade(req(), ctx())).rejects.toThrow(
      /wrote no transaction/,
    );
  });
});

/**
 * The connection type is the only thing that changes between a devnode run and
 * a real one, and it changes exactly two flags. Both are unsafe against a live
 * network: `--devnet` puts Leo in devnet mode, and `--skip-deploy-certificate`
 * substitutes placeholder certificates and verifying keys that a real network
 * rejects.
 */
describe("LeoDeployBackend against an HTTP network", () => {
  const httpCtx = () =>
    ctx({ connectionType: "http", endpoint: "https://api.explorer.provable.com/v1" });

  it.each([
    "deploy",
    "upgrade",
  ] as const)("omits --devnet and --skip-deploy-certificate on %s, even unproven", async (operation) => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    const backend = backendWith(fake);
    const build = operation === "deploy" ? backend.buildDeploy : backend.buildUpgrade;

    await build.call(backend, req({ prove: false }), httpCtx());

    expect(fake.onlyCall.argv).not.toContain("--devnet");
    expect(fake.onlyCall.argv).not.toContain("--skip-deploy-certificate");
    expect(fake.onlyCall.argv[fake.onlyCall.argv.indexOf("--endpoint") + 1]).toBe(
      "https://api.explorer.provable.com/v1",
    );
  });

  /**
   * The failure this closes: Leo reads `DEVNET` from a `.env` file in its
   * working directory and every parent of it, and the runner's cwd is the
   * project root. A project whose `.env` carries `DEVNET=true` from local
   * devnode work would, on an unset shell variable, send a real-network
   * deployment out in devnet mode. `--devnet` is valueless with no negative
   * form, so an explicit `DEVNET=false` is the only way to force it off.
   */
  it("pins DEVNET=false in the child environment", async () => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    await backendWith(fake).buildUpgrade(req(), httpCtx());
    expect(fake.onlyCall.env["DEVNET"]).toBe("false");
  });

  /**
   * `--save` without `--broadcast` is what makes an HTTP dry-run possible at
   * all: the transaction is built against the real network and handed back
   * without ever reaching it.
   */
  it("still builds without broadcasting", async () => {
    const fake = new FakeLeoCli({ savedTransactions: { [PROGRAM]: TX } });
    const result = await backendWith(fake).buildDeploy(req(), httpCtx());
    expect(result).toEqual({ kind: "built", transaction: TX });
    expect(fake.onlyCall.argv).not.toContain("--broadcast");
  });
});

describe("LeoDeployBackend.estimateDeploymentFee", () => {
  it("declines with a warning rather than throwing", async () => {
    const fake = new FakeLeoCli();
    const result = await backendWith(fake).estimateDeploymentFee(
      { programId: PROGRAM, aleoSource: ALEO_V1, importSources: new Map() },
      ctx(),
    );
    expect(result.estimate).toBeUndefined();
    expect(result.warning?.code).toBe("FEE_ESTIMATION_UNAVAILABLE");
  });
});
