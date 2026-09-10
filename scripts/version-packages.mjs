import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { applyReleasePlan } from "@changesets/apply-release-plan";
import { loadReleaseContext, planRelease } from "./release-plan.mjs";
import { describeVersions, loadPublicPackages } from "./release-policy.mjs";

// `--check` runs the same planning and policy validation as a real versioning run, then stops
// before writing manifests, changelogs, or the lockfile. CI runs it on every PR.
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const unknownArgs = args.filter((arg) => arg !== "--check");
if (unknownArgs.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArgs.join(" ")} (expected only --check)`);
}

const rootDir = process.cwd();

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

const context = await loadReleaseContext(rootDir);
const { publicPackages: before, publicNames, needsRecovery, changesets, preState } = context;
for (const warning of context.configWarnings) console.warn(`Changesets config: ${warning}`);

if (needsRecovery) {
  console.log(`Recovering the fixed release group from: ${describeVersions(before)}`);
  // Keep the fixed group active so pending changesets bump every public package
  // from the group's highest current version, including the already-published 0.2.0s.
}

if (changesets.length === 0 && !preState) {
  if (checkOnly && !needsRecovery) {
    console.log(
      `Release plan check passed: no unreleased changesets; public packages aligned at ${before[0].manifest.version}.`,
    );
    process.exit(0);
  }
  throw new Error("No unreleased changesets found");
}

const { releasePlan, plannedVersion } = planRelease(context);

if (checkOnly) {
  console.log(
    `Release plan check passed: ${changesets.length} changeset(s) converge ${publicNames.length} public packages at ${plannedVersion}.`,
  );
  process.exit(0);
}

await applyReleasePlan(
  releasePlan,
  context.packages,
  context.releaseConfig,
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
