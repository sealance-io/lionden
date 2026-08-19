/**
 * The Leo CLI deploy backend.
 *
 * Exists because the SDK builds a deployment in one monolithic WASM operation,
 * synthesizing and retaining proving keys for every function, record circuit
 * and uncached import until it completes. Large programs can exhaust WASM's
 * ~4 GiB limit during key setup and hang before control returns to JavaScript,
 * so the SDK cannot persist partial progress or resume. The Leo CLI caches
 * synthesized keys under `~/.aleo`, so a failed run resumes cheaply — that is
 * the capability gap, not a preference.
 *
 * Leo **builds only**. `--save` without `--broadcast` hands lionden a
 * transaction, and lionden broadcasts it, so dependency ordering, pending
 * markers, deployment records and confirmation polling all stay exactly where
 * they are.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeployError } from "../errors.js";
import { buildLeoArgv } from "./leo/argv.js";
import { buildLeoEnv } from "./leo/env.js";
import { LeoDeployError } from "./leo/errors.js";
import { type LeoRunArtifacts, readLeoOutcome, savedTransactionFileName } from "./leo/outcome.js";
import { assertPackageUnchanged, resolveLeoPackage } from "./leo/package.js";
import { type LeoRunner, spawnLeoRunner } from "./leo/runner.js";
import { assertLeoBinaryVersion, type LeoVersionProbe } from "./leo/version-gate.js";
import type {
  DeployBackend,
  DeployBackendCapabilities,
  DeployBackendContext,
  DeployBackendFeeEstimate,
  DeployBackendFeeRequest,
  DeployBackendPreflightContext,
  DeployBackendRequest,
  DeployBackendResult,
} from "./types.js";

export interface LeoDeployBackendOptions {
  /** Injected by tests; defaults to a real `spawn`. */
  readonly runner?: LeoRunner;
  /** Injected by tests; defaults to running `<leoBinary> --version`. */
  readonly versionProbe?: LeoVersionProbe;
}

class LeoDeployBackend implements DeployBackend {
  readonly provider = "leo" as const;
  readonly capabilities: DeployBackendCapabilities = {
    // `--save` without `--broadcast` is exactly a dry run, on any connection
    // type. Unlike the SDK's HTTP path, nothing here is atomic.
    buildWithoutBroadcast: true,
    // Leo does compute costs, but reading them back is a follow-up. The SDK
    // path is no better here: `estimateDeploymentFee` synthesizes keys and hits
    // the same memory wall as the deploy it is estimating.
    feeEstimation: false,
    resumableKeySynthesis: true,
  };

  private readonly runner: LeoRunner;
  private readonly versionProbe: LeoVersionProbe | undefined;

  constructor(options: LeoDeployBackendOptions = {}) {
    this.runner = options.runner ?? spawnLeoRunner;
    this.versionProbe = options.versionProbe;
  }

  async preflight(ctx: DeployBackendPreflightContext): Promise<void> {
    await (this.versionProbe
      ? assertLeoBinaryVersion(ctx.leoBinary, this.versionProbe)
      : assertLeoBinaryVersion(ctx.leoBinary));
  }

  async buildDeploy(
    req: DeployBackendRequest,
    ctx: DeployBackendContext,
  ): Promise<DeployBackendResult> {
    return this.run("deploy", req, ctx);
  }

  /**
   * Unreachable through `upgradeAction`, which rejects this combination at step
   * 0 in `assertDeployBackendCompatible` — before connecting, compiling, or
   * writing a pending marker. Kept as the backstop for any other caller holding
   * a `DeployBackend` directly, so "not supported" can never mean "silently
   * builds something else".
   */
  async buildUpgrade(
    _req: DeployBackendRequest,
    _ctx: DeployBackendContext,
  ): Promise<DeployBackendResult> {
    throw new DeployError(
      `The Leo deploy backend does not support \`upgrade\` yet in this version of lionden. ` +
        `Use \`--deploy-backend sdk\` (or set \`deploy.backend: "sdk"\`) to upgrade.`,
    );
  }

  async estimateDeploymentFee(
    _req: DeployBackendFeeRequest,
    _ctx: DeployBackendContext,
  ): Promise<DeployBackendFeeEstimate> {
    return {
      estimate: undefined,
      warning: {
        code: "FEE_ESTIMATION_UNAVAILABLE",
        message:
          `The Leo deploy backend does not report a fee estimate before deploying. ` +
          `Leo prints a full cost breakdown when the deployment runs.`,
      },
    };
  }

  /**
   * One Leo invocation, start to finish.
   *
   * The two staleness checks bracket the run on purpose: the pre-run one exists
   * to produce a good error early, and the post-run one is what actually
   * protects the recorded-artifact invariant, because Leo can recompile from
   * `src/` while it runs.
   */
  private async run(
    operation: "deploy" | "upgrade",
    req: DeployBackendRequest,
    ctx: DeployBackendContext,
  ): Promise<DeployBackendResult> {
    const pkg = resolveLeoPackage(ctx.artifactsDir, req.programId);

    // Signed transactions are not build artifacts, so this never lives under
    // `artifacts/`. 0o700 because the file is a signed, broadcastable payload.
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-leotx-"));
    fs.chmodSync(saveDir, 0o700);
    const jsonOutputPath = path.join(saveDir, "result.json");

    try {
      const argv = buildLeoArgv({
        operation,
        programId: req.programId,
        packageDir: pkg.dir,
        saveDir,
        jsonOutputPath,
        networkId: ctx.networkId,
        endpoint: ctx.endpoint,
        connectionType: ctx.connectionType,
        ...(ctx.consensusHeights !== undefined ? { consensusHeights: ctx.consensusHeights } : {}),
        priorityFee: req.priorityFee,
        privateFee: req.privateFee,
        localDependencyIds: req.localDependencyIds,
        prove: req.prove,
        ...(ctx.logLevel !== undefined ? { logLevel: ctx.logLevel } : {}),
      });

      // Named-role overrides (`deployer`, `admin`) arrive on the request and
      // must win over the network's default key.
      const effectiveKey = req.signerPrivateKey ?? ctx.privateKey;

      const result = await this.runner({
        binary: ctx.leoBinary,
        argv,
        env: buildLeoEnv({
          networkId: ctx.networkId,
          endpoint: ctx.endpoint,
          connectionType: ctx.connectionType,
          ...(effectiveKey !== undefined ? { privateKey: effectiveKey } : {}),
        }),
        cwd: ctx.projectRoot,
        timeoutMs: ctx.leo.timeout,
        logMode: ctx.leo.logMode,
        secrets: effectiveKey !== undefined ? [effectiveKey] : [],
      });

      if (result.timedOut) {
        throw new LeoDeployError(
          `Leo ${operation} for "${req.programId}" exceeded the ${ctx.leo.timeout} ms timeout ` +
            `(\`deploy.leo.timeout\`; set it to 0 to disable). Re-running resumes cheaply — Leo ` +
            `caches synthesized proving keys under \`~/.aleo\`, so work already done is not repeated.`,
          {
            programId: req.programId,
            stage: "timeout",
            exitCode: result.exitCode,
            stderrTail: result.stderr || result.stdout,
          },
        );
      }

      const outcome = readLeoOutcome(operation, req.programId, {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        savedFiles: readSavedFiles(saveDir),
        jsonOutput: readIfPresent(jsonOutputPath),
      } satisfies LeoRunArtifacts);

      // Must precede the return: the caller broadcasts whatever comes back.
      assertPackageUnchanged(pkg, req.programId);

      return { kind: "built", transaction: outcome.transaction };
    } finally {
      fs.rmSync(saveDir, { recursive: true, force: true });
    }
  }
}

/**
 * Read the `--save` directory.
 *
 * `result.json` is the `--json-output` file, which shares the directory but is
 * not a transaction; excluding it here keeps the outcome parser's
 * "exactly one transaction" assertion honest.
 */
function readSavedFiles(saveDir: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(saveDir)) return files;
  for (const name of fs.readdirSync(saveDir).sort()) {
    if (name === "result.json") continue;
    const full = path.join(saveDir, name);
    if (fs.statSync(full).isFile()) files.set(name, fs.readFileSync(full, "utf8"));
  }
  return files;
}

function readIfPresent(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function createLeoDeployBackend(options: LeoDeployBackendOptions = {}): DeployBackend {
  return new LeoDeployBackend(options);
}

export { savedTransactionFileName };
