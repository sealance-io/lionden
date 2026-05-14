/**
 * Test context — the primary interface for test suites.
 *
 * `setup()` creates a fully initialized test context with a running
 * devnode, network connection, and helpers for deploying programs
 * and executing transitions.
 */

import { preflightLeo, type LionDenRuntimeEnvironment } from "@lionden/core";
import type {
  NetworkConnection,
  NetworkManager,
  DevnodeAccount,
  Signer,
  RawTransitionOutput,
} from "@lionden/network";
import { DEVNODE_ACCOUNTS } from "@lionden/network";
import {
  createNamedAccountAccessor,
  type NamedAccountAccessor,
  type NamedAccounts,
} from "@lionden/config";
import type { ManagedDevnode } from "./devnode-lifecycle.js";
import { startDevnode, stopDevnode } from "./devnode-lifecycle.js";
import { clearFixtures } from "./fixtures.js";
import { createTestLre } from "./lre-factory.js";
import type {
  CachedDeploymentRecord,
  DeploymentCacheAccessor,
} from "./deployment-cache.js";

const MANUAL_DEVNODE_HEALTH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  /** LRE instance. If omitted, one is created automatically from the project config. */
  lre?: LionDenRuntimeEnvironment;
  /** Skip auto-starting a devnode (use existing connection). */
  skipDevnode?: boolean;
  /** Override devnode auto-block setting. When omitted, the config value is used. */
  autoBlock?: boolean;
  /** Network name to connect to (default: "devnode"). */
  network?: string;
}

export interface TestContext {
  /** The LionDen runtime environment. */
  readonly lre: LionDenRuntimeEnvironment;
  /** Pre-funded devnode accounts (empty on non-devnode networks). */
  readonly accounts: readonly DevnodeAccount[];
  /** Active network connection. */
  readonly connection: NetworkConnection;
  /** The network name this context is connected to. */
  readonly network: string;
  /**
   * Resolved named accounts for the active network.
   * Empty object ({}) when no namedAccounts are configured in the project.
   */
  readonly namedAccounts: NamedAccounts;
  /** Domain-native accessor for required named account roles. */
  readonly named: NamedAccountAccessor;
  /** Explicit string-based escape hatch for dynamic or post-upgrade ABI calls. */
  readonly raw: RawTestContext;
  /** Deploy a program by name. Returns the deploy result. */
  deploy(programName: string, options?: DeployOptions): Promise<DeployResult>;
  /** Execute a transition on a deployed program. */
  execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
  /** Advance blocks on devnode (no-op on non-devnode networks). */
  advanceBlocks(count: number): Promise<void>;
  /** Tear down the test context — stop devnode, disconnect, clear fixtures. */
  teardown(): Promise<void>;
}

export interface RawTestContext {
  /** Execute a transition with raw Leo string arguments. Prefer generated typechain wrappers when the ABI is known. */
  execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
}

export interface DeployOptions {
  priorityFee?: number;
  skipConfirm?: boolean;
  /** Skip compilation before deploying (artifacts must already exist) */
  noCompile?: boolean;
  /** Fail instead of reusing or skipping already-deployed programs. */
  noSkipDeployed?: boolean;
  /** Override proof generation for this deploy. Defaults to LIONDEN_PROVE. */
  prove?: boolean;
}

export interface DeployResult {
  readonly programId: string;
  readonly txId: string;
}

export interface ExecuteOptions {
  mode?: "local" | "onchain";
  fee?: number;
  /** Override the signer for this execution. */
  signer?: Signer;
  /**
   * Additional programs to load into the VM at execute time. Each entry
   * is a Leo program id (bare or `.aleo`) or a path to a local `.aleo`
   * file. Required for transitions that perform dynamic dispatch where
   * the targets cannot be inferred from static `import` statements.
   */
  imports?: readonly string[];
  /**
   * On-chain mode only. When omitted or `true`, the call awaits confirmation
   * and returns the matching transition's parsed outputs. When `false`, the
   * call returns immediately after broadcast with `outputs: []`; callers can
   * fetch outputs later via `ctx.connection.getTransitionOutputs(...)` or
   * inspect transitions directly via `ctx.connection.waitForConfirmation(...)`
   * (the documented escape hatch for reentrant or recursive flows).
   */
  awaitConfirmation?: boolean;
}

export interface ExecuteResult {
  readonly outputs: string[];
  /**
   * Faithful on-chain output shape including the `idOnly` discriminator for
   * dynamic-record outputs. Present only when the call awaited confirmation.
   */
  readonly rawOutputs?: readonly RawTransitionOutput[];
  readonly txId?: string;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Create a test context with a running devnode and active connection.
 *
 * If `lre` is not provided, one is created automatically by discovering
 * the project's `lionden.config.{ts,js,mjs}`. The test runner sets
 * `LIONDEN_PROJECT_ROOT` so config discovery works from Vitest workers.
 *
 * Call this in `beforeAll` or at the start of a test. Call `ctx.teardown()`
 * in `afterAll` to clean up.
 *
 * ```typescript
 * import { setup, type TestContext } from "@lionden/testing";
 *
 * let ctx: TestContext;
 * beforeAll(async () => { ctx = await setup(); });
 * afterAll(async () => { await ctx.teardown(); });
 * ```
 */
export async function setup(opts: SetupOptions = {}): Promise<TestContext> {
  const lre = opts.lre ?? (await createTestLre());
  const { skipDevnode, autoBlock, network: networkName } = opts;
  let managedDevnode: ManagedDevnode | undefined;

  // When LIONDEN_PROVE is set (by the test runner's --prove flag),
  // force real proof generation on devnode deploy and execute calls.
  const prove = process.env["LIONDEN_PROVE"] === "true";

  // 1. Optionally start a devnode
  if (!skipDevnode && lre.config.testing.autoStartDevnode) {
    await preflightLeo(lre.config);
    // Only pass autoBlock override if the caller explicitly set it.
    // Otherwise, let startDevnode() read the value from config.
    managedDevnode = await startDevnode(
      lre.config,
      autoBlock !== undefined ? { autoBlock } : undefined,
    );
  }

  // 2. Connect to the network
  const manager = lre.network as NetworkManager;
  const connectedNetwork = networkName ?? lre.config.defaultNetwork;
  const connection = await manager.connect(connectedNetwork);

  if (!managedDevnode && connection.type === "devnode") {
    await assertManualDevnodeReachable(
      connection,
      connectedNetwork,
      getManualDevnodeReasons(skipDevnode, lre.config.testing.autoStartDevnode),
    );
  }

  // 3. Build context
  const executeRaw = async (
    programId: string,
    transitionName: string,
    args: string[],
    execOpts?: ExecuteOptions,
  ): Promise<ExecuteResult> => {
    const mode = execOpts?.mode ?? "onchain";
    const awaitOpt =
      mode === "onchain"
        ? { awaitConfirmation: execOpts?.awaitConfirmation ?? true }
        : {};
    const result = await connection.execute(programId, transitionName, args, {
      mode,
      fee: execOpts?.fee,
      prove,
      signer: execOpts?.signer,
      ...awaitOpt,
      ...(execOpts?.imports === undefined ? {} : { imports: execOpts.imports }),
    });
    return {
      outputs: result.outputs,
      ...(result.rawOutputs === undefined ? {} : { rawOutputs: result.rawOutputs }),
      txId: result.txId,
    };
  };

  const ctx: TestContext = {
    lre,
    accounts: connection.type === "devnode" ? DEVNODE_ACCOUNTS : [],
    connection,
    network: connectedNetwork,
    namedAccounts: lre.namedAccounts,
    named: createNamedAccountAccessor(lre.namedAccounts, connectedNetwork),
    raw: {
      execute: executeRaw,
    },

    async deploy(programName: string, deployOpts?: DeployOptions): Promise<DeployResult> {
      const normalizedId = normalizeProgramId(programName);

      // Check deployment cache first (sync, zero-latency for previously deployed programs)
      const deploymentCache = lre.deployments as DeploymentCacheAccessor | null;
      if (deploymentCache && !deployOpts?.noSkipDeployed) {
        const cached = deploymentCache.getCached(normalizedId, connectedNetwork);
        if (isCompleteDeploymentWithTxId(cached)) {
          return { programId: normalizedId, txId: cached.txId };
        }
      }

      const taskResult = await lre.tasks.run("deploy", {
        program: programName,
        network: connectedNetwork,
        priorityFee: deployOpts?.priorityFee,
        skipConfirm: deployOpts?.skipConfirm,
        noCompile: deployOpts?.noCompile,
        noSkipDeployed: deployOpts?.noSkipDeployed,
        ...(deployOpts?.prove !== undefined || prove
          ? { prove: deployOpts?.prove ?? prove }
          : {}),
      });

      // Unwrap DeployTaskResult discriminated union
      const wrapped = taskResult as { mode?: string; results?: unknown[] };
      if (wrapped.mode && wrapped.mode !== "deploy") {
        throw new Error(
          `Expected deploy task to return mode "deploy", got "${wrapped.mode}". ` +
            `This may indicate --preflight or --dry-run was passed unexpectedly.`,
        );
      }

      // Support both the new { mode, results } shape and legacy array shape
      const results: Array<{ programId: string; txId: string }> =
        wrapped.mode === "deploy" && Array.isArray(wrapped.results)
          ? (wrapped.results as Array<{ programId: string; txId: string }>)
          : (taskResult as Array<{ programId: string; txId: string }>);

      const deployed = getDeployResultForProgram(results, normalizedId);
      if (deployed) {
        return {
          programId: normalizeProgramId(deployed.programId),
          txId: deployed.txId,
        };
      }

      const cached = deploymentCache?.getCached(normalizedId, connectedNetwork) ?? null;
      if (isCompleteDeploymentWithTxId(cached)) {
        return { programId: normalizedId, txId: cached.txId };
      }

      throw createEmptyDeployResultError(
        programName,
        normalizedId,
        connectedNetwork,
        cached,
      );
    },

    execute: executeRaw,

    async advanceBlocks(count: number): Promise<void> {
      if (connection.advanceBlocks) {
        await connection.advanceBlocks(count);
      }
    },

    async teardown(): Promise<void> {
      clearFixtures();
      // Invalidate the deployment cache so the next test starts fresh.
      const deploymentCache = lre.deployments as DeploymentCacheAccessor | null;
      if (deploymentCache) {
        deploymentCache.invalidateSession(connectedNetwork);
      }
      await manager.disconnectAll();
      if (managedDevnode) {
        await stopDevnode(managedDevnode);
      }
    },
  };

  return ctx;
}

async function assertManualDevnodeReachable(
  connection: NetworkConnection,
  networkName: string,
  reasons: readonly string[],
): Promise<void> {
  try {
    await withTimeout(
      connection.getBlockHeight(),
      MANUAL_DEVNODE_HEALTH_TIMEOUT_MS,
      `manual devnode health check timed out after ${MANUAL_DEVNODE_HEALTH_TIMEOUT_MS}ms`,
    );
  } catch (err) {
    await Promise.resolve(connection.close()).catch(() => {});
    const cause = causeMessage(err);
    throw new Error(
      `Devnode network "${networkName}" is not reachable at ${connection.endpoint} ` +
        `(Aleo network "${connection.networkId}"). ` +
        `setup() did not start a managed devnode because ${formatReasons(reasons)}. ` +
        `Start a devnode for that endpoint, enable testing.autoStartDevnode, ` +
        `or pass a reachable network. Cause: ${cause}`,
      { cause: err },
    );
  }
}

function getManualDevnodeReasons(
  skipDevnode: boolean | undefined,
  autoStartDevnode: boolean,
): string[] {
  const reasons: string[] = [];
  if (skipDevnode) {
    reasons.push("setup({ skipDevnode: true }) was passed");
  }
  if (!autoStartDevnode) {
    reasons.push("testing.autoStartDevnode is false");
  }
  return reasons.length > 0 ? reasons : ["no managed devnode was started"];
}

function formatReasons(reasons: readonly string[]): string {
  if (reasons.length === 1) {
    return reasons[0]!;
  }
  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]!}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.length > 0) {
    return cause;
  }
  return String(cause);
}

function normalizeProgramId(programName: string): string {
  return programName.endsWith(".aleo") ? programName : `${programName}.aleo`;
}

function isCompleteDeploymentWithTxId(
  record: CachedDeploymentRecord | null,
): record is CachedDeploymentRecord & { readonly txId: string } {
  return (
    record?.status === "complete" &&
    typeof record.txId === "string" &&
    record.txId.length > 0
  );
}

function getDeployResultForProgram(
  results: Array<{ programId: string; txId: string }>,
  normalizedId: string,
): { programId: string; txId: string } | undefined {
  return (
    results.find((result) => normalizeProgramId(result.programId) === normalizedId) ??
    results[results.length - 1]
  );
}

function createEmptyDeployResultError(
  requestedProgram: string,
  normalizedId: string,
  networkName: string,
  cached: CachedDeploymentRecord | null,
): Error {
  return new Error(
    `Deploy task produced no transaction for "${requestedProgram}" on network "${networkName}", ` +
      `and no complete cached deployment with a txId exists for "${normalizedId}" ` +
      `(${describeCachedDeployment(cached)}). ` +
      `Use { noSkipDeployed: true } when the recipe or test setup must fail instead of reusing or skipping an existing deployment.`,
  );
}

function describeCachedDeployment(
  cached: CachedDeploymentRecord | null,
): string {
  if (!cached) {
    return "cached state: none";
  }
  if (cached.status === "complete") {
    return "cached state: complete record without txId";
  }
  return `cached state: ${cached.status} record without txId`;
}
