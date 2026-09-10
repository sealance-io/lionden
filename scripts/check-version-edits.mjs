/**
 * Blocks hand-edited public package versions.
 *
 * Compares the parsed `version` of every public workspace manifest between two git trees:
 * `--base <git-ref>` (CI passes the pull request's merge base) and `--head <git-ref>` (CI passes
 * the pull request head; defaults to the working tree). Any public package whose version differs
 * is an error: versions change only through the Version Packages PR, which CI validates
 * separately with validate-release-state.mjs.
 *
 * Packages present on only one side are reported, not rejected: a new public package must still
 * join the fixed group at the shared version, which the release-plan check enforces.
 *
 * Zero-dependency: runs before `npm ci`. Performs no writes to the repository.
 */
import { withExportedTree } from "./git-tree.mjs";
import { loadPublicPackages } from "./release-policy.mjs";

const args = process.argv.slice(2);
const refs = {};
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if ((flag === "--base" || flag === "--head") && index + 1 < args.length && !(flag in refs)) {
    refs[flag] = args[index + 1];
    index += 1;
  } else {
    throw new Error(
      `Unknown arguments: ${args.slice(index).join(" ")} (expected --base <git-ref> [--head <git-ref>])`,
    );
  }
}
if (!("--base" in refs)) throw new Error("--base <git-ref> is required");
const baseRef = refs["--base"];
const headRef = refs["--head"];

const rootDir = process.cwd();

function versionMap(dir) {
  return new Map(loadPublicPackages(dir).map(({ manifest }) => [manifest.name, manifest.version]));
}

const base = await withExportedTree(rootDir, baseRef, async (dir) => versionMap(dir));
const head =
  headRef === undefined
    ? versionMap(rootDir)
    : await withExportedTree(rootDir, headRef, async (dir) => versionMap(dir));
const headLabel = headRef ?? "the working tree";

const edited = [];
for (const [name, version] of head) {
  if (!base.has(name)) {
    console.log(`New public package ${name}@${version} (not in ${baseRef})`);
  } else if (base.get(name) !== version) {
    edited.push(`${name}: ${base.get(name)} -> ${version}`);
  }
}
for (const [name, version] of base) {
  if (!head.has(name)) console.log(`Public package ${name}@${version} removed since ${baseRef}`);
}

if (edited.length > 0) {
  throw new Error(
    `Public package versions changed between ${baseRef} and ${headLabel}. Versions change only through the Version Packages PR.\n${edited.join("\n")}`,
  );
}
console.log(
  `Version check OK: ${head.size} public package versions unchanged between ${baseRef} and ${headLabel}.`,
);
