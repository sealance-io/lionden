import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertFixedReleaseGroup,
  describeVersions,
  loadPublicPackages,
} from "./release-policy.mjs";

const rootDir = process.cwd();
const configPath = join(rootDir, ".changeset", "config.json");
const configRaw = readFileSync(configPath, "utf8");
const config = JSON.parse(configRaw);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args]);
  } else {
    run("npm", args);
  }
}

const before = loadPublicPackages(rootDir);
assertFixedReleaseGroup(config, before);

const needsBootstrap = new Set(before.map(({ manifest }) => manifest.version)).size !== 1;

if (needsBootstrap) {
  console.log(`Bootstrapping the fixed release group from: ${describeVersions(before)}`);
  writeFileSync(configPath, `${JSON.stringify({ ...config, fixed: [] }, null, 2)}\n`);
}

try {
  run(process.execPath, [join(rootDir, "node_modules", "@changesets", "cli", "bin.js"), "version"]);
} finally {
  if (needsBootstrap) writeFileSync(configPath, configRaw);
}

const after = loadPublicPackages(rootDir);
const versions = new Set(after.map(({ manifest }) => manifest.version));
if (versions.size !== 1) {
  throw new Error(`Public packages did not converge on one version: ${describeVersions(after)}`);
}

runNpm([
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--allow-git=none",
]);
run(process.execPath, [join(rootDir, "scripts", "validate-lockfile.mjs")]);

console.log(`Fixed release group aligned at ${after[0].manifest.version}.`);
