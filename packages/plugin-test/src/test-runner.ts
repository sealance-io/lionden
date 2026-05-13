/**
 * Vitest programmatic runner.
 *
 * Wraps Vitest's Node API to run tests with LionDen-specific configuration.
 * Discovers test files from `test/` relative to the project root.
 *
 * Sets environment variables so that `@lionden/testing` can discover the
 * project config and reconstruct the LRE in Vitest worker processes:
 * - `LIONDEN_PROJECT_ROOT` — project root for config discovery
 * - `LIONDEN_PROVE` — "true" when `--prove` flag is set
 */

export interface TestRunnerOptions {
  /** Grep pattern to filter tests by name. */
  grep?: string;
  /** Test timeout in milliseconds. */
  timeout?: number;
  /** Run compile task before testing. Default: true */
  compile?: boolean;
  /** Generate proofs during execution (slower). Default: false */
  prove?: boolean;
  /**
   * Test file or glob patterns to include. Defaults to the standard test glob.
   *
   * Patterns are passed directly to Vitest with the project root configured
   * as Vitest's root.
   */
  files?: string[];
  /**
   * Run test files in parallel. Default: false.
   *
   * LionDen tests connect to a single devnode/HTTP endpoint, so parallel
   * file execution creates nonce/deploy contention. Default serial execution
   * keeps multi-file projects predictable; users with isolated test files
   * can opt in via `--parallel` on the `test` task.
   */
  parallel?: boolean;
  /** Project root directory. */
  root: string;
}

export interface TestRunnerResult {
  /** Whether all tests passed. */
  readonly success: boolean;
  /** Total number of test files. */
  readonly testFiles: number;
  /** Number of passing tests. */
  readonly passed: number;
  /** Number of failing tests. */
  readonly failed: number;
  /** Number of skipped tests. */
  readonly skipped: number;
}

/**
 * Run tests using Vitest's programmatic API.
 *
 * Dynamically imports vitest/node to avoid bundling it as a hard dependency
 * at the type level — it's a peerDependency that users must install.
 */
export async function runTests(options: TestRunnerOptions): Promise<TestRunnerResult> {
  // Set env vars for worker processes before Vitest starts.
  // Workers inherit process.env, so @lionden/testing can discover
  // the project config and construct an LRE from any worker thread.
  process.env["LIONDEN_PROJECT_ROOT"] = options.root;
  if (options.prove) {
    process.env["LIONDEN_PROVE"] = "true";
  } else {
    delete process.env["LIONDEN_PROVE"];
  }

  const { startVitest } = await import("vitest/node");

  const vitest = await startVitest("test", [], {
    root: options.root,
    // Force one-shot mode; Vitest defaults to watch in TTY sessions.
    run: true,
    watch: false,
    // Run against the LionDen project only; repo-level Vitest workspace
    // config should not leak into scaffolded/example project execution.
    config: false,
    include: options.files ?? ["test/**/*.test.ts"],
    testTimeout: options.timeout ?? 120_000,
    hookTimeout: options.timeout ?? 120_000,
    fileParallelism: options.parallel === true,
    ...(options.grep ? { testNamePattern: options.grep } : {}),
  });

  if (!vitest) {
    return { success: false, testFiles: 0, passed: 0, failed: 0, skipped: 0 };
  }

  // Wait for tests to complete
  await vitest.close();

  // Collect results
  const state = vitest.state;
  const files = state.getFiles();

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of files) {
    const tasks = file.tasks;
    for (const t of tasks) {
      if (t.result?.state === "pass") passed++;
      else if (t.result?.state === "fail") failed++;
      else skipped++;
    }
  }

  return {
    success: failed === 0,
    testFiles: files.length,
    passed,
    failed,
    skipped,
  };
}
