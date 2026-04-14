/**
 * Test context — the primary interface for test suites.
 *
 * `setup()` creates a fully initialized test context with a running
 * devnode, network connection, and helpers for deploying programs
 * and executing transitions.
 */

import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { NetworkConnection, NetworkManager, DevnodeAccount, Signer } from "@lionden/network";
import { DEVNODE_ACCOUNTS } from "@lionden/network";
import type { ManagedDevnode } from "./devnode-lifecycle.js";
import { startDevnode, stopDevnode } from "./devnode-lifecycle.js";
import { clearFixtures } from "./fixtures.js";
import { createTestLre } from "./lre-factory.js";
import type { DeploymentCacheAccessor } from "./deployment-cache.js";

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
  /** Pre-funded devnode accounts. */
  readonly accounts: readonly DevnodeAccount[];
  /** Active network connection. */
  readonly connection: NetworkConnection;
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

export interface DeployOptions {
  priorityFee?: number;
  skipConfirm?: boolean;
  /** Skip compilation before deploying (artifacts must already exist) */
  noCompile?: boolean;
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
}

export interface ExecuteResult {
  readonly outputs: string[];
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
  // force real proof generation on devnode execute calls.
  const prove = process.env["LIONDEN_PROVE"] === "true";

  // 1. Optionally start a devnode
  if (!skipDevnode && lre.config.testing.autoStartDevnode) {
    // Only pass autoBlock override if the caller explicitly set it.
    // Otherwise, let startDevnode() read the value from config.
    managedDevnode = await startDevnode(
      lre.config,
      autoBlock !== undefined ? { autoBlock } : undefined,
    );
  }

  // 2. Connect to the network
  const manager = lre.network as NetworkManager;
  const connection = await manager.connect(networkName ?? lre.config.defaultNetwork);

  // 3. Build context
  const ctx: TestContext = {
    lre,
    accounts: DEVNODE_ACCOUNTS,
    connection,

    async deploy(programName: string, deployOpts?: DeployOptions): Promise<DeployResult> {
      const normalizedId = programName.endsWith(".aleo")
        ? programName
        : `${programName}.aleo`;

      // Check deployment cache first (sync, zero-latency for previously deployed programs)
      const deploymentCache = lre.deployments as DeploymentCacheAccessor | null;
      if (deploymentCache) {
        const cached = deploymentCache.getCached(normalizedId, "devnode");
        if (cached && cached.status === "complete" && cached.txId) {
          return { programId: cached.programId, txId: cached.txId };
        }
      }

      const taskResult = await lre.tasks.run("deploy", {
        program: programName,
        priorityFee: deployOpts?.priorityFee,
        skipConfirm: deployOpts?.skipConfirm,
        noCompile: deployOpts?.noCompile,
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

      const last = results[results.length - 1];
      if (!last) {
        throw new Error(`Deploy task returned no results for "${programName}".`);
      }
      return { programId: last.programId, txId: last.txId };
    },

    async execute(
      programId: string,
      transitionName: string,
      args: string[],
      execOpts?: ExecuteOptions,
    ): Promise<ExecuteResult> {
      const result = await connection.execute(programId, transitionName, args, {
        mode: execOpts?.mode ?? "onchain",
        fee: execOpts?.fee,
        prove,
        signer: execOpts?.signer,
      });
      return { outputs: result.outputs, txId: result.txId };
    },

    async advanceBlocks(count: number): Promise<void> {
      if (connection.advanceBlocks) {
        await connection.advanceBlocks(count);
      }
    },

    async teardown(): Promise<void> {
      clearFixtures();
      // Invalidate the deployment cache for devnode so the next test starts fresh.
      // Disk state is left for cross-process sharing; stale disk records are
      // re-validated against on-chain state on the next async read.
      const deploymentCache = lre.deployments as DeploymentCacheAccessor | null;
      if (deploymentCache) {
        deploymentCache.invalidateSession("devnode");
      }
      await manager.disconnectAll();
      if (managedDevnode) {
        await stopDevnode(managedDevnode);
      }
    },
  };

  return ctx;
}
