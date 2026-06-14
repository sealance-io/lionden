/**
 * Vitest programmatic runner.
 *
 * Wraps Vitest's Node API to run tests with LionDen-specific configuration.
 * Discovers test files from `test/` relative to the project root.
 *
 * Sets environment variables so that `@lionden/testing` can discover the
 * project config and reconstruct the LRE in Vitest worker processes:
 * - `LIONDEN_PROJECT_ROOT` — project root for config discovery
 * - `LIONDEN_PROVE` — canonical "true" when proving is on; deleted otherwise.
 *   `options.prove === true` sets it, `false` clears it, and `undefined` honors
 *   (and canonicalizes) a truthy ambient `LIONDEN_PROVE`.
 * - `LIONDEN_NETWORK` — the explicit `--network` to target in workers; set when
 *   `options.network` is provided, deleted otherwise.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parseBooleanEnv } from "@lionden/config";
import type { startVitest as startVitestType } from "vitest/node";

type VitestStartOptions = NonNullable<Parameters<typeof startVitestType>[2]>;

export interface TestCoverageOptions {
  /**
   * Root used for package-source coverage globs. Defaults to the LionDen
   * project root, but repo smoke coverage passes the monorepo root explicitly.
   */
  sourceRoot?: string;
  /** Directory where Vitest writes coverage artifacts for this run. */
  reportsDirectory?: string;
  /**
   * Optional blob reporter path for later `vitest --merge-reports`.
   * When set, Vitest uses only the blob reporter for test results.
   */
  blobOutputFile?: string;
}

export interface TestRunnerOptions {
  /** Grep pattern to filter tests by name. */
  grep?: string;
  /** Test timeout in milliseconds. */
  timeout?: number;
  /** Run compile task before testing. Default: true */
  compile?: boolean;
  /**
   * Generate proofs during execution (slower). `true` sets `LIONDEN_PROVE`,
   * `false` clears it, and omitting it honors a truthy ambient `LIONDEN_PROVE`.
   */
  prove?: boolean;
  /**
   * Network to bridge to Vitest workers via `LIONDEN_NETWORK`; omitted clears it.
   * Mirrors the explicit `--network` selection so each worker's LRE targets the
   * same network instead of the on-disk config default.
   */
  network?: string;
  /**
   * Test file or glob patterns to include. Defaults to the standard test glob.
   *
   * Patterns are resolved relative to the LionDen project root. Coverage runs
   * may use a separate Vitest root so package source can be transformed.
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
  /** Collect package-source coverage. Default: false. */
  coverage?: boolean | TestCoverageOptions;
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

interface VitestTaskLike {
  readonly result?: { readonly state?: string };
  readonly tasks?: readonly VitestTaskLike[];
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
  // undefined → honor (and canonicalize) ambient env; true → set; false → clear.
  // `false ?? x === false`, so an explicit false still clears; only `undefined`
  // falls through to the ambient-env parse. No onInvalid callback here — this is
  // the worker-boundary owner and must stay silent (Finding 3).
  const prove = options.prove ?? parseBooleanEnv(process.env["LIONDEN_PROVE"], false);
  if (prove) process.env["LIONDEN_PROVE"] = "true";
  else delete process.env["LIONDEN_PROVE"];

  // Bridge the explicit --network selection to workers. Set only when supplied,
  // so default runs leave LIONDEN_NETWORK unset (zero behavior change).
  if (options.network) process.env["LIONDEN_NETWORK"] = options.network;
  else delete process.env["LIONDEN_NETWORK"];

  const { startVitest } = await import("vitest/node");
  const coverageOptions = normalizeCoverageOptions(options.coverage);
  const vitestRoot = coverageOptions?.sourceRoot ?? options.root;
  const coverage = resolveCoverageOptions(options, coverageOptions);
  const reporters = resolveReporters(coverageOptions);
  const alias = coverageOptions ? resolveCoverageAliases(vitestRoot) : undefined;

  const vitestOptions: VitestStartOptions = {
    root: vitestRoot,
    // Force one-shot mode; Vitest defaults to watch in TTY sessions.
    run: true,
    watch: false,
    // Run against the LionDen project only; repo-level Vitest workspace
    // config should not leak into scaffolded/example project execution.
    config: false,
    include: resolveIncludePatterns(options.root, vitestRoot, options.files),
    testTimeout: options.timeout ?? 120_000,
    hookTimeout: options.timeout ?? 120_000,
    fileParallelism: options.parallel === true,
    ...(coverage ? { coverage } : {}),
    ...(reporters ? { reporters } : {}),
    ...(alias ? { alias } : {}),
    ...(options.grep ? { testNamePattern: options.grep } : {}),
  };

  const vitest = await startVitest("test", [], vitestOptions);

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
    const counts = countTasks(file.tasks as readonly VitestTaskLike[]);
    passed += counts.passed;
    failed += counts.failed;
    skipped += counts.skipped;
  }

  return {
    success: failed === 0,
    testFiles: files.length,
    passed,
    failed,
    skipped,
  };
}

function countTasks(tasks: readonly VitestTaskLike[]): {
  passed: number;
  failed: number;
  skipped: number;
} {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const task of tasks) {
    if (task.tasks && task.tasks.length > 0) {
      if (task.result?.state === "fail") failed++;
      const childCounts = countTasks(task.tasks);
      passed += childCounts.passed;
      failed += childCounts.failed;
      skipped += childCounts.skipped;
      continue;
    }

    if (task.result?.state === "pass") passed++;
    else if (task.result?.state === "fail") failed++;
    else skipped++;
  }

  return { passed, failed, skipped };
}

const coverageInclude = ["packages/*/src/**/*.ts"];
const coverageExclude = [
  "packages/*/src/**/*.test.ts",
  "packages/*/src/**/*.contract.test.ts",
  "packages/*/src/**/*.d.ts",
  "packages/test-internals/src/**/*.ts",
  "packages/*/src/**/__goldens__/**",
];

function normalizeCoverageOptions(
  coverage: TestRunnerOptions["coverage"],
): TestCoverageOptions | undefined {
  if (!coverage) return undefined;
  return coverage === true ? {} : coverage;
}

function resolveCoverageOptions(
  options: TestRunnerOptions,
  coverageOptions: TestCoverageOptions | undefined,
): VitestStartOptions["coverage"] {
  if (!coverageOptions) return undefined;

  const sourceRoot = coverageOptions.sourceRoot ?? options.root;

  return {
    provider: "v8" as const,
    enabled: true,
    allowExternal: true,
    include: coverageInclude.map((pattern) => toCoverageGlob(sourceRoot, pattern)),
    exclude: coverageExclude.map((pattern) => toCoverageGlob(sourceRoot, pattern)),
    reportsDirectory: coverageOptions.reportsDirectory ?? join(sourceRoot, "coverage"),
    reporter: ["text-summary", "html", "lcov"],
  };
}

function resolveReporters(
  coverage: TestCoverageOptions | undefined,
): VitestStartOptions["reporters"] {
  if (!coverage?.blobOutputFile) return undefined;

  return [["blob", { outputFile: coverage.blobOutputFile }]];
}

function resolveIncludePatterns(
  projectRoot: string,
  vitestRoot: string,
  files: string[] | undefined,
) {
  const patterns = files ?? ["test/**/*.test.ts"];
  return patterns.map((pattern) => {
    const absolutePattern = isAbsolute(pattern) ? pattern : join(projectRoot, pattern);
    return relative(vitestRoot, absolutePattern).replaceAll("\\", "/");
  });
}

function resolveCoverageAliases(sourceRoot: string): VitestStartOptions["alias"] {
  const packagesDir = join(sourceRoot, "packages");
  if (!existsSync(packagesDir)) return undefined;

  const aliases: Record<string, string> = {};
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const packageRoot = join(packagesDir, entry.name);
    const packageJsonPath = join(packageRoot, "package.json");
    const sourceEntrypoint = join(packageRoot, "src", "index.ts");
    if (!existsSync(packageJsonPath) || !existsSync(sourceEntrypoint)) continue;

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    if (typeof packageJson.name === "string") {
      aliases[packageJson.name] = sourceEntrypoint;
    }
  }

  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

function toCoverageGlob(root: string, pattern: string): string {
  return join(root, pattern).replaceAll("\\", "/");
}
