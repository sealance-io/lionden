/**
 * Validates a generated release state (the "Version Packages" PR, or the merge commit about to
 * be published): every public package shares one version and no unreleased changesets remain.
 *
 * With `--base <git-ref>`, additionally assembles the release plan that `<git-ref>` (the branch
 * the release was generated from) still has pending and requires the current version to be
 * exactly that plan's result. Eleven hand-substituted versions satisfy alignment alone; they do
 * not satisfy this. Manifest/lockfile agreement is covered separately by validate-lockfile.mjs.
 *
 * Performs no writes to the repository. The base tree is exported with `git archive` into a
 * temporary directory that is removed afterwards.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReleaseContext, planRelease } from "./release-plan.mjs";
import { describeVersions } from "./release-policy.mjs";

const args = process.argv.slice(2);
let baseRef;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--base" && index + 1 < args.length && baseRef === undefined) {
    baseRef = args[index + 1];
    index += 1;
  } else {
    throw new Error(
      `Unknown arguments: ${args.slice(index).join(" ")} (expected only --base <git-ref>)`,
    );
  }
}

const rootDir = process.cwd();

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: rootDir, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function exportTree(ref) {
  const dir = mkdtempSync(join(tmpdir(), "release-base-"));
  try {
    const archive = join(dir, "base.tar");
    git(["archive", "--format=tar", "--output", archive, ref]);
    const tar = spawnSync("tar", ["-xf", archive, "-C", dir], { encoding: "utf8" });
    if (tar.error) throw tar.error;
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.trim()}`);
    rmSync(archive);
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const context = await loadReleaseContext(rootDir);
for (const warning of context.configWarnings) console.warn(`Changesets config: ${warning}`);

if (context.needsRecovery) {
  throw new Error(`Public packages are not aligned: ${describeVersions(context.publicPackages)}`);
}
const version = context.publicPackages[0].manifest.version;

if (context.changesets.length > 0) {
  throw new Error(
    `Unreleased changesets remain: ${context.changesets.map(({ id }) => id).join(", ")}`,
  );
}

if (baseRef !== undefined) {
  const baseDir = exportTree(baseRef);
  try {
    const baseContext = await loadReleaseContext(baseDir);
    if (baseContext.changesets.length === 0 && !baseContext.preState) {
      throw new Error(`${baseRef} has no unreleased changesets, so no release state is expected`);
    }
    const { plannedVersion } = planRelease(baseContext);
    if (plannedVersion !== version) {
      throw new Error(
        `Release state ${version} does not match the ${baseRef} release plan, which converges at ${plannedVersion}`,
      );
    }
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

console.log(
  `Release state OK: ${context.publicNames.length} public packages at ${version}, no unreleased changesets${baseRef === undefined ? "" : `, matches the ${baseRef} release plan`}.`,
);
