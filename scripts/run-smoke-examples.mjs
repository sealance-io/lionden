import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const CORE_EXAMPLES = [
  "hello-world",
  "token",
  "multi-program",
  "nft-registry",
  "upgradeable-counter",
  "async-escrow",
];

const ALEO_PORT_TEST_TIMEOUT_MS = 240_000;
const PROVE_TEST_TIMEOUT_MS = 900_000;
const CI_TEST_TIMEOUT_MULTIPLIER = 4;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const { listOnly, typecheck, prove, coverage, groups } = parseArgs(process.argv.slice(2));
const requestedGroups = groups.length > 0 ? groups : ["core"];

function usage() {
  console.error(
    "Usage: node scripts/run-smoke-examples.mjs [--list] [--no-typecheck] [--prove] [--coverage] [core] [aleo-ports] [all]",
  );
}

function parseArgs(args) {
  const parsed = {
    listOnly: false,
    typecheck: true,
    prove: false,
    coverage: false,
    groups: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--list":
        parsed.listOnly = true;
        break;
      case "--no-typecheck":
        parsed.typecheck = false;
        break;
      case "--prove":
        parsed.prove = true;
        break;
      case "--coverage":
        parsed.coverage = true;
        break;
      default:
        parsed.groups.push(arg);
        break;
    }
  }

  return parsed;
}

function coreConfigs() {
  return CORE_EXAMPLES.map((name) => configPath(join("examples", name)));
}

function aleoPortConfigs() {
  const root = join(repoRoot, "examples", "aleo-ports");
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => configPath(join("examples", "aleo-ports", entry.name)))
    .filter((config) => existsSync(join(repoRoot, config)))
    .sort((a, b) => a.localeCompare(b));
}

function configPath(examplePath) {
  return join(examplePath, "lionden.config.ts");
}

function resolveConfigs(group) {
  switch (group) {
    case "core":
      return coreConfigs();
    case "aleo-ports":
      return aleoPortConfigs();
    case "all":
      return [...coreConfigs(), ...aleoPortConfigs()];
    default:
      usage();
      throw new Error(`Unknown smoke example group "${group}".`);
  }
}

function unique(values) {
  return [...new Set(values)];
}

const configs = unique(requestedGroups.flatMap(resolveConfigs));
if (configs.length === 0) {
  console.error(`No smoke example configs found for: ${requestedGroups.join(", ")}`);
  process.exit(1);
}

for (const config of configs) {
  if (!existsSync(join(repoRoot, config))) {
    console.error(`Smoke example config not found: ${config}`);
    process.exit(1);
  }
}

if (listOnly) {
  for (const config of configs) {
    console.log(relative(repoRoot, join(repoRoot, config)));
  }
  process.exit(0);
}

const coverageContext = coverage ? createCoverageContext(requestedGroups) : undefined;
const runStartedAt = performance.now();

printRunHeader(coverageContext);

for (const config of configs) {
  const exampleName = dirname(config);
  const testTimeout = testTimeoutForConfig(config);
  console.log(`\n==> ${exampleName}`);

  run("compile", ["--import", "tsx", "packages/cli/src/bin.ts", "--config", config, "compile"]);

  if (typecheck) {
    run("typecheck", [
      join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(repoRoot, exampleName, "tsconfig.json"),
      "--noEmit",
    ]);
  }

  run(
    "test",
    [
      "--import",
      "tsx",
      "packages/cli/src/bin.ts",
      "--config",
      config,
      "test",
      ...(coverage ? ["--coverage"] : []),
      ...(prove ? ["--prove"] : []),
      ...(testTimeout === undefined ? [] : ["--timeout", String(testTimeout)]),
    ],
    coverageContext ? coverageEnv(coverageContext, config) : undefined,
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

printTotalRuntime();

function isAleoPortConfig(config) {
  return config.split(/[\\/]/).includes("aleo-ports");
}

function testTimeoutForConfig(config) {
  if (prove) return testTimeout(PROVE_TEST_TIMEOUT_MS);
  if (isAleoPortConfig(config)) return testTimeout(ALEO_PORT_TEST_TIMEOUT_MS);
  return undefined;
}

function createCoverageContext(groups) {
  const lane = coverageLane(groups);
  const root = join(repoRoot, ".vitest", "smoke-coverage", lane);
  const blobDir = join(root, "blobs");
  const runsDir = join(root, "runs");
  const finalReportsDirectory = join(repoRoot, "coverage", "smoke", lane);

  rmSync(root, { recursive: true, force: true });
  mkdirSync(blobDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  return { lane, blobDir, runsDir, finalReportsDirectory };
}

function coverageLane(groups) {
  if (groups.includes("all") || groups.length > 1) return "all";
  return groups[0] ?? "core";
}

function coverageEnv(context, config) {
  const id = coverageExampleId(config);
  const reportsDirectory = join(context.runsDir, id);
  const blobOutputFile = join(context.blobDir, `${id}.json`);

  mkdirSync(reportsDirectory, { recursive: true });

  return {
    LIONDEN_TEST_COVERAGE_SOURCE_ROOT: repoRoot,
    LIONDEN_TEST_COVERAGE_REPORTS_DIRECTORY: reportsDirectory,
    LIONDEN_TEST_COVERAGE_BLOB_OUTPUT_FILE: blobOutputFile,
  };
}

function coverageExampleId(config) {
  const exampleDir = dirname(config);
  if (isAleoPortConfig(config)) return `aleo-ports-${basename(exampleDir)}`;
  return basename(exampleDir);
}

function printRunHeader(context) {
  console.log("== Smoke example config ==");
  console.log(`Groups: ${requestedGroups.join(", ")}`);
  console.log(`Typecheck: ${formatEnabled(typecheck)}`);
  console.log(
    `Prove: ${formatEnabled(prove)}${
      prove ? ` (test timeout ${formatTestTimeout(PROVE_TEST_TIMEOUT_MS)})` : ""
    }`,
  );
  if (!prove && configs.some(isAleoPortConfig)) {
    console.log(`Aleo ports test timeout: ${formatTestTimeout(ALEO_PORT_TEST_TIMEOUT_MS)}`);
  }
  console.log(`Coverage: ${formatEnabled(coverage)}${context ? ` (lane ${context.lane})` : ""}`);
  console.log(`Configs (${configs.length}):`);
  for (const config of configs) {
    console.log(`  - ${config}`);
  }
}

function printTotalRuntime() {
  console.log(`\n== Smoke example runtime: ${formatDuration(performance.now() - runStartedAt)} ==`);
}

function formatEnabled(value) {
  return value ? "enabled" : "disabled";
}

function testTimeout(baseTimeout) {
  return isCi() ? baseTimeout * CI_TEST_TIMEOUT_MULTIPLIER : baseTimeout;
}

function isCi() {
  const value = process.env["CI"];
  return value !== undefined && value !== "" && value.toLowerCase() !== "false";
}

function formatTestTimeout(baseTimeout) {
  const effectiveTimeout = testTimeout(baseTimeout);
  if (effectiveTimeout === baseTimeout) return formatDuration(baseTimeout);
  return (
    `${formatDuration(effectiveTimeout)} ` +
    `(CI ${CI_TEST_TIMEOUT_MULTIPLIER}x from ${formatDuration(baseTimeout)})`
  );
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
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
