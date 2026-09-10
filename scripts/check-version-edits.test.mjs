import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(rootDir, "scripts/check-version-edits.mjs");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(dir, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function commitAll(dir, message) {
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "--quiet", "--allow-empty", "--message", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function setVersion(dir, name, version) {
  const path = join(dir, "packages", name, "package.json");
  writeJson(path, { ...JSON.parse(readFileSync(path, "utf8")), version });
}

function run(dir, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
}

function assertPasses(dir, args, message) {
  const result = run(dir, args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, message);
}

function assertRejected(dir, args, message) {
  const result = run(dir, args);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, message);
}

const fixture = mkdtempSync(join(tmpdir(), "version-edits-"));
try {
  writeJson(join(fixture, "package.json"), {
    name: "fixture",
    private: true,
    workspaces: ["packages/*"],
  });
  for (const [name, version] of [
    ["core", "0.3.0"],
    ["cli", "0.3.0"],
  ]) {
    mkdirSync(join(fixture, "packages", name), { recursive: true });
    writeJson(join(fixture, "packages", name, "package.json"), { name: `@scope/${name}`, version });
  }
  mkdirSync(join(fixture, "packages", "internal"));
  writeJson(join(fixture, "packages", "internal", "package.json"), {
    name: "@scope/internal",
    private: true,
    version: "0.0.0",
  });
  git(fixture, ["init", "--quiet", "--initial-branch=main"]);
  const mergeBase = commitAll(fixture, "base");

  assertRejected(fixture, [], /--base <git-ref> is required/);
  assertRejected(fixture, ["--base", mergeBase, "--strict"], /Unknown arguments: --strict/);
  assertRejected(fixture, ["--base", "no-such-ref"], /git read-tree no-such-ref failed/);

  // Unchanged versions pass, whether compared against the working tree or an explicit head.
  assertPasses(
    fixture,
    ["--base", mergeBase],
    /Version check OK: 2 public package versions unchanged/,
  );
  writeFileSync(join(fixture, "packages/core/index.js"), "export {};\n");
  const codeOnly = commitAll(fixture, "code change");
  assertPasses(fixture, ["--base", mergeBase, "--head", codeOnly], /Version check OK/);

  // Private package versions are not policed.
  setVersion(fixture, "internal", "9.9.9");
  assertPasses(fixture, ["--base", mergeBase], /Version check OK/);

  // A hand-edited public version is rejected, in the working tree and in a committed head.
  setVersion(fixture, "cli", "0.3.1");
  assertRejected(
    fixture,
    ["--base", mergeBase],
    /Public package versions changed between .* and the working tree[\s\S]*@scope\/cli: 0\.3\.0 -> 0\.3\.1/,
  );
  const edited = commitAll(fixture, "hand edit");
  assertRejected(
    fixture,
    ["--base", mergeBase, "--head", edited],
    /@scope\/cli: 0\.3\.0 -> 0\.3\.1/,
  );
  // The working tree is not consulted when --head is given: a fixed tree passes against the edit.
  setVersion(fixture, "cli", "0.3.0");
  assertRejected(
    fixture,
    ["--base", mergeBase, "--head", edited],
    /@scope\/cli: 0\.3\.0 -> 0\.3\.1/,
  );
  assertPasses(fixture, ["--base", mergeBase, "--head", codeOnly], /Version check OK/);

  // A release that landed on the base after branching does not implicate the branch: compare
  // the branch head against the merge base, not against the base tip.
  commitAll(fixture, "revert hand edit");
  git(fixture, ["checkout", "--quiet", "-b", "release", mergeBase]);
  setVersion(fixture, "core", "0.4.0");
  setVersion(fixture, "cli", "0.4.0");
  const released = commitAll(fixture, "chore(release): version packages");
  assertPasses(fixture, ["--base", mergeBase, "--head", codeOnly], /Version check OK/);
  assertRejected(fixture, ["--base", released, "--head", codeOnly], /0\.4\.0 -> 0\.3\.0/);

  // Committed export-ignore attributes must not hide manifests from the comparison.
  writeFileSync(
    join(fixture, ".gitattributes"),
    "packages/*/package.json export-ignore\npackage.json export-ignore\n",
  );
  setVersion(fixture, "cli", "0.4.1");
  const hidden = commitAll(fixture, "hand edit behind export-ignore");
  assertRejected(
    fixture,
    ["--base", released, "--head", hidden],
    /@scope\/cli: 0\.4\.0 -> 0\.4\.1/,
  );
  assertRejected(fixture, ["--base", released], /@scope\/cli: 0\.4\.0 -> 0\.4\.1/);
  setVersion(fixture, "cli", "0.4.0");
  const reverted = commitAll(fixture, "revert hand edit behind export-ignore");
  assertPasses(
    fixture,
    ["--base", released, "--head", reverted],
    /2 public package versions unchanged/,
  );

  // New and removed public packages are reported, not rejected.
  mkdirSync(join(fixture, "packages", "extra"));
  writeJson(join(fixture, "packages", "extra", "package.json"), {
    name: "@scope/extra",
    version: "0.4.0",
  });
  rmSync(join(fixture, "packages", "cli"), { recursive: true });
  const reshaped = commitAll(fixture, "add and remove packages");
  const result = run(fixture, ["--base", released, "--head", reshaped]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /New public package @scope\/extra@0\.4\.0/);
  assert.match(result.stdout, /Public package @scope\/cli@0\.4\.0 removed/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(
  "Version edit tests passed: public versions may only change via the Version Packages PR.",
);
