/**
 * Test context — the primary interface for test suites.
 *
 * `setup()` creates a fully initialized test context with a running
 * devnode, network connection, and helpers for deploying programs
 * and executing transitions.
 */

import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { NetworkConnection, NetworkManager, DevnodeAccount } from "@lionden/network";
import { DEVNODE_ACCOUNTS } from "@lionden/network";
import type { ManagedDevnode } from "./devnode-lifecycle.js";
import { startDevnode, stopDevnode } from "./devnode-lifecycle.js";
import { clearFixtures } from "./fixtures.js";
import { createTestLre } from "./lre-factory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  /** LRE instance. If omitted, one is created automatically from the project config. */
  hre?: LionDenRuntimeEnvironment;
  /** Skip auto-starting a devnode (use existing connection). */
  skipDevnode?: boolean;
  /** Override devnode auto-block setting. When omitted, the config value is used. */
  autoBlock?: boolean;
  /** Network name to connect to (default: "devnode"). */
  network?: string;
}

export interface TestContext {
  /** The LionDen runtime environment. */
  readonly hre: LionDenRuntimeEnvironment;
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
}

export interface DeployResult {
  readonly programId: string;
  readonly txId: string;
}

export interface ExecuteOptions {
  mode?: "local" | "onchain";
  fee?: number;
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
 * If `hre` is not provided, one is created automatically by discovering
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
  const hre = opts.hre ?? (await createTestLre());
  const { skipDevnode, autoBlock, network: networkName } = opts;
  let managedDevnode: ManagedDevnode | undefined;

  // When LIONDEN_PROVE is set (by the test runner's --prove flag),
  // force real proof generation on devnode execute calls.
  const prove = process.env["LIONDEN_PROVE"] === "true";

  // 1. Optionally start a devnode
  if (!skipDevnode && hre.config.testing.autoStartDevnode) {
    // Only pass autoBlock override if the caller explicitly set it.
    // Otherwise, let startDevnode() read the value from config.
    managedDevnode = await startDevnode(
      hre.config,
      autoBlock !== undefined ? { autoBlock } : undefined,
    );
  }

  // 2. Connect to the network
  const manager = hre.network as NetworkManager;
  const connection = await manager.connect(networkName ?? hre.config.defaultNetwork);

  // 3. Build context
  const ctx: TestContext = {
    hre,
    accounts: DEVNODE_ACCOUNTS,
    connection,

    async deploy(programName: string, deployOpts?: DeployOptions): Promise<DeployResult> {
      const result = await hre.tasks.run("deploy", {
        program: programName,
        priorityFee: deployOpts?.priorityFee,
        skipConfirm: deployOpts?.skipConfirm,
      });

      const results = result as Array<{ programId: string; txId: string }>;
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
      await manager.disconnectAll();
      if (managedDevnode) {
        await stopDevnode(managedDevnode);
      }
    },
  };

  return ctx;
}
