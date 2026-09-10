import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyReleasePlan } from "@changesets/apply-release-plan";
import { assembleReleasePlan } from "@changesets/assemble-release-plan";
import { readConfig } from "@changesets/config";
import { readPreState } from "@changesets/pre";
import { readChangesets } from "@changesets/read";
import { getPackages } from "@manypkg/get-packages";
import {
  assertChangesetTargets,
  assertCoordinatedRecoveryState,
  assertFixedReleaseGroup,
  describeVersions,
  loadPublicPackages,
} from "./release-policy.mjs";

// `--check` runs the same planning and policy validation as a real versioning run, then stops
// before writing manifests, changelogs, or the lockfile. CI runs it on every PR.
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const unknownArgs = args.filter((arg) => arg !== "--check");
if (unknownArgs.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArgs.join(" ")} (expected only --check)`);
}

const rootDir = process.cwd();
const configPath = join(rootDir, ".changeset", "config.json");
const configRaw = readFileSync(configPath, "utf8");
const writtenConfig = JSON.parse(configRaw);

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
const publicNames = assertFixedReleaseGroup(writtenConfig, before);

const needsRecovery = new Set(before.map(({ manifest }) => manifest.version)).size !== 1;
const packages = await getPackages(rootDir);
const configResult = await readConfig(rootDir, packages);
if (configResult.errors) {
  throw new Error(`Invalid Changesets config:\n${configResult.errors.join("\n")}`);
}
for (const warning of configResult.warnings) console.warn(`Changesets config: ${warning}`);

const releaseConfig = configResult.config;

if (needsRecovery) {
  assertCoordinatedRecoveryState(before);
  console.log(`Recovering the fixed release group from: ${describeVersions(before)}`);
  // Keep the fixed group active so pending changesets bump every public package
  // from the group's highest current version, including the already-published 0.2.0s.
}

const [changesets, preState] = await Promise.all([readChangesets(rootDir), readPreState(rootDir)]);
if (changesets.length === 0 && !preState) {
  if (checkOnly && !needsRecovery) {
    console.log(
      `Release plan check passed: no unreleased changesets; public packages aligned at ${before[0].manifest.version}.`,
    );
    process.exit(0);
  }
  throw new Error("No unreleased changesets found");
}
assertChangesetTargets(changesets, publicNames);

const releasePlan = assembleReleasePlan(changesets, packages, releaseConfig, preState);
const plannedVersions = new Map(before.map(({ manifest }) => [manifest.name, manifest.version]));
for (const release of releasePlan.releases) {
  if (plannedVersions.has(release.name)) plannedVersions.set(release.name, release.newVersion);
}
const plannedVersionSet = new Set(plannedVersions.values());
if (plannedVersionSet.size !== 1) {
  throw new Error(
    `Release plan does not converge public packages: ${[...plannedVersions].map(([name, version]) => `${name}@${version}`).join(", ")}`,
  );
}
const [plannedVersion] = plannedVersionSet;
if (needsRecovery && plannedVersion !== "0.3.0") {
  throw new Error(`The coordinated recovery must converge at 0.3.0, not ${plannedVersion}`);
}

if (checkOnly) {
  console.log(
    `Release plan check passed: ${changesets.length} changeset(s) converge ${publicNames.length} public packages at ${plannedVersion}.`,
  );
  process.exit(0);
}

await applyReleasePlan(
  releasePlan,
  packages,
  releaseConfig,
  undefined,
  join(rootDir, "node_modules", "@changesets", "cli", "dist"),
);

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
