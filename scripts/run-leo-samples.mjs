import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

/**
 * Runner for the leo-samples smoke lane.
 *
 *   1. checks the .upstream submodule is initialized,
 *   2. regenerates generated/** from it (copying authored suites into each
 *      project's test/),
 *   3. runs the in-process suites — the 0f adapter-proof gate + the Phase-2
 *      compile/codegen suite — in one process via the lane vitest config,
 *   3b. typechecks each on-chain project (`tsc --noEmit`) against its
 *      freshly-emitted bindings (`--no-typecheck` to skip),
 *   4. loops the on-chain projects sequentially (shared devnode on
 *      127.0.0.1:3030, no proving by default), driving the CLI `test` task per
 *      generated project so each discovers its own config.
 *
 * The CLI is run from source (`--import tsx packages/cli/src/bin.ts`) so V8
 * attributes coverage to packages/**. On-chain suites stay sequential (shared
 * devnode); see test/fixtures/leo-samples/README.md § Port spike.
 */

const PROVE_TEST_TIMEOUT_MS = 900_000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const fixturesRoot = join(repoRoot, "test", "fixtures", "leo-samples");
const upstreamRoot = join(fixturesRoot, ".upstream");
const generatedRoot = join(fixturesRoot, "generated");
const gapfillerDir = join(fixturesRoot, "gapfiller");
const laneVitestConfig = join(fixturesRoot, "vitest.config.ts");

const { listOnly, prove, coverage, onChain, typecheck } = parseArgs(process.argv.slice(2));

function usage() {
  console.error(
    "Usage: node scripts/run-leo-samples.mjs [--list] [--prove] [--coverage] [--no-onchain] [--no-typecheck]",
  );
}

function parseArgs(args) {
  const parsed = { listOnly: false, prove: false, coverage: false, onChain: true, typecheck: true };
  for (const arg of args) {
    switch (arg) {
      case "--list":
        parsed.listOnly = true;
        break;
      case "--prove":
        parsed.prove = true;
        break;
      case "--coverage":
        parsed.coverage = true;
        break;
      case "--no-onchain":
        parsed.onChain = false;
        break;
      case "--no-typecheck":
        parsed.typecheck = false;
        break;
      default:
        usage();
        throw new Error(`Unknown argument "${arg}".`);
    }
  }
  return parsed;
}

function assertSubmodule() {
  if (!existsSync(join(upstreamRoot, "README.md"))) {
    console.error(
      "leo-samples submodule is not initialized. Run:\n" +
        "  git submodule update --init test/fixtures/leo-samples/.upstream",
    );
    process.exit(1);
  }
}

/** Generated on-chain projects that have an authored suite copied into test/. */
function onChainProjects() {
  if (!existsSync(generatedRoot)) return [];
  const projects = readdirSync(generatedRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(generatedRoot, e.name))
    .filter(hasSuite)
    .sort((a, b) => a.localeCompare(b));
  // The hand-authored gap-filler is a normal project alongside the adapted ones.
  if (hasSuite(gapfillerDir)) projects.push(gapfillerDir);
  return projects;
}

function hasSuite(projectDir) {
  const testDir = join(projectDir, "test");
  if (!existsSync(testDir)) return false;
  return readdirSync(testDir).some((f) => f.endsWith(".test.ts"));
}

const runStartedAt = performance.now();

if (listOnly) {
  assertSubmodule();
  regen();
  for (const p of onChainProjects()) console.log(relative(repoRoot, p));
  process.exit(0);
}

printHeader();
assertSubmodule();
regen();

// Coverage context: created exactly ONCE, here — before the in-process step —
// so the in-process blob and the per-project on-chain blobs land in the same
// blobDir for the final `--merge-reports`. Gated on `onChain` too: the merge
// step runs only inside `if (onChain)` below, so a `--coverage --no-onchain`
// run would orphan the in-process blob (no merge, no HTML). createCoverageContext()
// also `rmSync`es + recreates the blob dirs, so creating it under --no-onchain
// would wipe/scaffold directories nothing will merge. The supported coverage
// path is therefore the full lane (`npm run test:smoke:leo-samples:coverage`);
// `--coverage --no-onchain` yields only the in-process text-summary.
const coverageContext = coverage && onChain ? createCoverageContext() : undefined;

// (3) In-process suites: 0f proof gate + compile/codegen coverage. When merging,
// emit the in-process run's coverage as a distinct blob (`in-process.json`) into
// the shared blobDir so the merge step unions the codegen-path coverage the
// on-chain `lionden test` cache-skips. Filename can't collide with on-chain ids
// (project basenames).
run(
  "in-process (proof + compile-codegen)",
  [
    join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--config",
    laneVitestConfig,
    ...(coverage ? ["--coverage"] : []),
  ],
  coverageContext
    ? { LEO_SAMPLES_INPROC_COVERAGE_BLOB: join(coverageContext.blobDir, "in-process.json") }
    : undefined,
);

// (3b) Typecheck each on-chain project against its freshly-emitted bindings.
// `lionden test` runs Vitest through transpilation only, so a type-only
// binding/API incompatibility would slip through CI; this enforces the authored
// typecheck the same way run-smoke-examples.mjs does for the example projects.
if (typecheck) {
  for (const projectDir of onChainProjects()) {
    run(`typecheck ${basename(projectDir)}`, [
      join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(projectDir, "tsconfig.json"),
      "--noEmit",
    ]);
  }
}

// (4) On-chain suites, sequential (shared devnode).
if (onChain) {
  for (const projectDir of onChainProjects()) {
    const name = basename(projectDir);
    console.log(`\n==> ${name}`);
    run(
      `test ${name}`,
      [
        "--import",
        "tsx",
        join("packages", "cli", "src", "bin.ts"),
        "--config",
        join(projectDir, "lionden.config.ts"),
        "test",
        ...(coverage ? ["--coverage"] : []),
        ...(prove ? ["--prove", "--timeout", String(PROVE_TEST_TIMEOUT_MS)] : []),
      ],
      coverageContext ? coverageEnv(coverageContext, name, projectDir) : undefined,
    );
  }
  if (coverageContext) {
    run("merge coverage", [
      join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      `--merge-reports=${coverageContext.blobDir}`,
      "--coverage",
      `--coverage.reportsDirectory=${coverageContext.finalReportsDirectory}`,
    ]);
  }
}

printTotalRuntime();

function regen() {
  run("regenerate generated/**", [
    "--import",
    "tsx",
    join("test", "fixtures", "leo-samples", "adapter", "regen.ts"),
  ]);
}

function createCoverageContext() {
  const root = join(repoRoot, ".vitest", "smoke-coverage", "leo-samples");
  const blobDir = join(root, "blobs");
  const runsDir = join(root, "runs");
  const finalReportsDirectory = join(repoRoot, "coverage", "smoke", "leo-samples");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(blobDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  return { blobDir, runsDir, finalReportsDirectory };
}

function coverageEnv(context, id, projectDir) {
  const reportsDirectory = join(context.runsDir, id);
  const blobOutputFile = join(context.blobDir, `${id}.json`);
  mkdirSync(reportsDirectory, { recursive: true });
  // Credit this project's *executed* generated bindings to coverage. The glob is
  // per-project (each <project>/typechain/ is a distinct absolute path), so it
  // never double-counts another project's wrappers and it reaches the gap-filler,
  // whose typechain lives at gapfiller/typechain (outside generated/). Resolved
  // against the source root (repoRoot) by the plugin-test coverage builder.
  const extraInclude = `${relative(repoRoot, projectDir)}/typechain/**/*.ts`.replaceAll("\\", "/");
  return {
    LIONDEN_TEST_COVERAGE_SOURCE_ROOT: repoRoot,
    LIONDEN_TEST_COVERAGE_REPORTS_DIRECTORY: reportsDirectory,
    LIONDEN_TEST_COVERAGE_BLOB_OUTPUT_FILE: blobOutputFile,
    LIONDEN_TEST_COVERAGE_EXTRA_INCLUDE: extraInclude,
  };
}

function printHeader() {
  console.log("== leo-samples smoke lane ==");
  console.log(`Prove: ${prove ? "enabled" : "disabled"}`);
  console.log(`Coverage: ${coverage ? "enabled" : "disabled"}`);
  console.log(`Typecheck: ${typecheck ? "enabled" : "disabled"}`);
  console.log(`On-chain: ${onChain ? "enabled" : "disabled"}`);
}

function printTotalRuntime() {
  console.log(
    `\n== leo-samples lane runtime: ${formatDuration(performance.now() - runStartedAt)} ==`,
  );
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function run(label, commandArgs, env = undefined) {
  console.log(`--> ${label}`);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    printTotalRuntime();
    process.exit(result.status ?? 1);
  }
}
