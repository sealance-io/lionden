import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_EXAMPLES = [
  "hello-world",
  "token",
  "multi-program",
  "nft-registry",
  "upgradeable-counter",
  "async-escrow",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const typecheck = !args.includes("--no-typecheck");
const groups = args.filter((arg) => arg !== "--list" && arg !== "--no-typecheck");
const requestedGroups = groups.length > 0 ? groups : ["core"];

function usage() {
  console.error("Usage: node scripts/run-smoke-examples.mjs [--list] [--no-typecheck] [core] [aleo-ports] [all]");
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

for (const config of configs) {
  const exampleName = dirname(config);
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

  run("test", ["--import", "tsx", "packages/cli/src/bin.ts", "--config", config, "test"]);
}

function run(label, commandArgs) {
  console.log(`--> ${label}`);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) process.exit(result.status ?? 1);
}
