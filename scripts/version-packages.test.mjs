import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COORDINATED_RECOVERY_START_VERSIONS, loadPublicPackages } from "./release-policy.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(rootDir, ".changeset/config.json"), "utf8"));
const historicalVersions = COORDINATED_RECOVERY_START_VERSIONS;
const recoveryReleases = Object.entries(historicalVersions)
  .filter(([, version]) => version !== "0.2.0")
  .map(([name]) => [name, "minor"]);
const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function addChangeset(dir, id, releases, summary) {
  writeFileSync(
    join(dir, ".changeset", `${id}.md`),
    `---\n${releases.map(([name, type]) => `${JSON.stringify(name)}: ${type}`).join("\n")}\n---\n\n${summary}\n`,
  );
}

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "version-packages-"));
  mkdirSync(join(dir, ".changeset"));
  mkdirSync(join(dir, "scripts"));
  writeJson(join(dir, "package.json"), {
    name: "release-fixture",
    private: true,
    workspaces: ["packages/*"],
  });
  // manypkg identifies npm workspaces by the presence of this file. The empty
  // entries also ensure the test requires actual lockfile regeneration.
  writeJson(join(dir, "package-lock.json"), { lockfileVersion: 3, packages: {} });
  // Only changelog attribution is replaced: assembly, application, npm lockfile
  // regeneration, and validation all run through the real versioning script.
  writeJson(join(dir, ".changeset/config.json"), {
    ...config,
    changelog: ["./changelog.cjs", {}],
    format: false,
  });
  writeFileSync(
    join(dir, ".changeset/changelog.cjs"),
    'exports.getReleaseLine = async (cs) => "- " + cs.summary;\nexports.getDependencyReleaseLine = async () => "";\n',
  );
  for (const script of ["validate-lockfile.mjs", "release-policy.mjs"]) {
    copyFileSync(join(rootDir, "scripts", script), join(dir, "scripts", script));
  }
  // Use the real public dependency graph with pinned historical versions and no
  // external dependencies, so npm runs fully offline without registry fixtures.
  for (const { manifest } of loadPublicPackages(rootDir)) {
    const pkgDir = join(dir, "packages", manifest.name.replace("@lionden/", ""));
    mkdirSync(pkgDir, { recursive: true });
    const fixtureManifest = { name: manifest.name, version: historicalVersions[manifest.name] };
    for (const section of dependencySections) {
      if (!manifest[section]) continue;
      fixtureManifest[section] = Object.fromEntries(
        Object.keys(manifest[section])
          .filter((name) => Object.hasOwn(historicalVersions, name))
          .map((name) => [name, `^${historicalVersions[name]}`]),
      );
    }
    writeJson(join(pkgDir, "package.json"), fixtureManifest);
  }
  const privateDir = join(dir, "packages", "test-internals");
  mkdirSync(privateDir);
  writeJson(join(privateDir, "package.json"), {
    name: "@lionden/test-internals",
    private: true,
    version: "0.0.0",
    dependencies: { "@lionden/core": "^0.2.0" },
  });
  writeFileSync(join(dir, ".gitignore"), ".npm-cache/\n");
  const init = spawnSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync("git", ["add", "--all"], { cwd: dir, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  return dir;
}

function runVersioning(dir, args = []) {
  return spawnSync(process.execPath, [join(rootDir, "scripts/version-packages.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      npm_config_offline: "true",
      npm_config_cache: join(dir, ".npm-cache"),
      npm_config_update_notifier: "false",
    },
  });
}

function runValidation(dir, args = []) {
  return spawnSync(
    process.execPath,
    [join(rootDir, "scripts/validate-release-state.mjs"), ...args],
    { cwd: dir, encoding: "utf8", timeout: 60_000 },
  );
}

function assertValidationRejected(dir, message, args = []) {
  const before = snapshot(dir);
  const result = runValidation(dir, args);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, message);
  assert.deepEqual(snapshot(dir), before);
}

function assertValidationPasses(dir, message, args = []) {
  const before = snapshot(dir);
  const result = runValidation(dir, args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, message);
  assert.deepEqual(snapshot(dir), before);
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

function snapshot(dir) {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.parentPath.startsWith(join(dir, ".git")))
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, readFileSync(path, "utf8")];
      }),
  );
}

function assertRejectedWithoutWrites(dir, message, args = []) {
  const before = snapshot(dir);
  const result = runVersioning(dir, args);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, message);
  assert.deepEqual(snapshot(dir), before);
}

function assertCheckPassesWithoutWrites(dir, message) {
  const before = snapshot(dir);
  const result = runVersioning(dir, ["--check"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, message);
  assert.deepEqual(snapshot(dir), before);
}

function assertRejectedInBothModes(dir, message) {
  assertRejectedWithoutWrites(dir, message, ["--check"]);
  assertRejectedWithoutWrites(dir, message);
}

function assertVersioned(dir, version) {
  const configBefore = readFileSync(join(dir, ".changeset/config.json"), "utf8");
  const result = runVersioning(dir);
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Lockfile OK:/);
  assert.equal(readFileSync(join(dir, ".changeset/config.json"), "utf8"), configBefore);
  const packages = loadPublicPackages(dir);
  assert.equal(packages.length, 11);
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  for (const pkg of packages) {
    assert.equal(pkg.manifest.version, version, pkg.manifest.name);
    assert.equal(lock.packages[pkg.relativeDir].version, version);
    assert.ok(readFileSync(join(pkg.dir, "CHANGELOG.md"), "utf8").includes(`## ${version}\n`));
    for (const section of dependencySections) {
      for (const range of Object.values(pkg.manifest[section] ?? {})) {
        assert.equal(range, `^${version}`, `${pkg.manifest.name} ${section}`);
      }
    }
  }
  const privateManifest = JSON.parse(
    readFileSync(join(dir, "packages/test-internals/package.json"), "utf8"),
  );
  assert.equal(privateManifest.version, "0.0.0");
  assert.equal(privateManifest.dependencies["@lionden/core"], `^${version}`);
  assert.equal(existsSync(join(dir, "packages/test-internals/CHANGELOG.md")), false);
  assert.deepEqual(
    readdirSync(join(dir, ".changeset")).filter((name) => name.endsWith(".md")),
    [],
  );
}

const fixture = createFixture();
try {
  addChangeset(fixture, "recovery", recoveryReleases, "Coordinate the public release.");
  addChangeset(fixture, "compiler-fix", [["@lionden/leo-compiler", "patch"]], "Preserve metadata.");
  addChangeset(
    fixture,
    "compiler-feature",
    [["@lionden/leo-compiler", "minor"]],
    "Allow version metadata.",
  );

  assertRejectedWithoutWrites(fixture, /Unknown arguments: --dry-run/, ["--dry-run"]);
  assertRejectedWithoutWrites(fixture, /Unknown arguments: --dry-run/, ["--check", "--dry-run"]);

  const cliPath = join(fixture, "packages/cli/package.json");
  const cli = JSON.parse(readFileSync(cliPath, "utf8"));
  writeJson(cliPath, { ...cli, version: "0.1.3" });
  assertRejectedInBothModes(fixture, /Refusing to recover from an unexpected public-package skew/);
  writeJson(cliPath, cli);

  // Changesets naming a private or example workspace still assemble into a valid plan, so they
  // are rejected explicitly in both modes. Unknown names already fail assembly; the guard reports
  // them with the same message before assembly runs.
  const strayPath = join(fixture, ".changeset/stray.md");
  addChangeset(fixture, "stray", [["@lionden/test-internals", "patch"]], "Private target.");
  assertRejectedInBothModes(
    fixture,
    /stray: @lionden\/test-internals is not a public fixed-group package/,
  );
  addChangeset(fixture, "stray", [["not-a-workspace", "patch"]], "Unknown target.");
  assertRejectedInBothModes(fixture, /stray: not-a-workspace is not a public fixed-group package/);
  rmSync(strayPath);

  addChangeset(
    fixture,
    "compiler-feature",
    [["@lionden/leo-compiler", "major"]],
    "Breaking change.",
  );
  assertRejectedInBothModes(fixture, /must converge at 0\.3\.0, not 1\.0\.0/);
  addChangeset(
    fixture,
    "compiler-feature",
    [["@lionden/leo-compiler", "minor"]],
    "Allow version metadata.",
  );

  assertCheckPassesWithoutWrites(
    fixture,
    /Release plan check passed: 3 changeset\(s\) converge 11 public packages at 0\.3\.0\./,
  );
  // A skewed tree with pending changesets is not a release state.
  assertValidationRejected(fixture, /Public packages are not aligned/);
  assertValidationRejected(fixture, /Unknown arguments: --base/, ["--base"]);
  assertValidationRejected(fixture, /Unknown arguments: --strict/, ["--strict"]);
  const recoveryBase = commitAll(fixture, "pending recovery changesets");
  assertVersioned(fixture, "0.3.0");
  const compilerChangelog = readFileSync(
    join(fixture, "packages/leo-compiler/CHANGELOG.md"),
    "utf8",
  );
  assert.ok(compilerChangelog.includes("Preserve metadata."));
  assert.ok(compilerChangelog.includes("Allow version metadata."));
  // Aligned with nothing pending: ordinary PRs and the Version Packages PR must pass the check,
  // while a real versioning run still has nothing to do.
  assertCheckPassesWithoutWrites(
    fixture,
    /Release plan check passed: no unreleased changesets; public packages aligned at 0\.3\.0\./,
  );
  assertRejectedWithoutWrites(fixture, /No unreleased changesets found/);

  // Generated release state: aligned, nothing pending, and exactly what the base planned.
  assertValidationPasses(
    fixture,
    /Release state OK: 11 public packages at 0\.3\.0, no unreleased changesets\./,
  );
  assertValidationPasses(
    fixture,
    /Release state OK: 11 public packages at 0\.3\.0, no unreleased changesets, matches the .* release plan\./,
    ["--base", recoveryBase],
  );
  // Eleven hand-substituted versions satisfy alignment but not the base plan.
  const publicManifests = loadPublicPackages(fixture).map(({ manifestPath }) => [
    manifestPath,
    readFileSync(manifestPath, "utf8"),
  ]);
  for (const [manifestPath, raw] of publicManifests) {
    writeJson(manifestPath, { ...JSON.parse(raw), version: "0.3.1" });
  }
  assertValidationPasses(fixture, /Release state OK: 11 public packages at 0\.3\.1/);
  assertValidationRejected(
    fixture,
    /Release state 0\.3\.1 does not match the .* release plan, which converges at 0\.3\.0/,
    ["--base", recoveryBase],
  );
  for (const [manifestPath, raw] of publicManifests) writeFileSync(manifestPath, raw);
  // Merge topologies. The publish workflow validates against main's tip before the push
  // (github.event.before), which is `recoveryBase` for every merge method. A multi-commit
  // rebase merge shows why HEAD^1 is not a substitute: its first parent is already versioned.
  const versioned = commitAll(fixture, "chore(release): version packages");
  const cliChangelog = join(fixture, "packages/cli/CHANGELOG.md");
  writeFileSync(cliChangelog, `${readFileSync(cliChangelog, "utf8")}\nRelease note fix.\n`);
  commitAll(fixture, "docs: release note fix");
  assertValidationPasses(fixture, /matches the .* release plan/, ["--base", recoveryBase]);
  assertValidationRejected(
    fixture,
    /has no unreleased changesets, so no release state is expected/,
    ["--base", "HEAD^1"],
  );
  assertValidationRejected(
    fixture,
    /has no unreleased changesets, so no release state is expected/,
    ["--base", versioned],
  );
  // Merge-commit topology: first parent is the pre-push tip, so both refs agree.
  git(fixture, ["checkout", "--quiet", "-b", "main-before", recoveryBase]);
  git(fixture, ["merge", "--quiet", "--no-ff", "--no-edit", "main"]);
  assertValidationPasses(fixture, /matches the .* release plan/, ["--base", "HEAD^1"]);
  assertValidationPasses(fixture, /matches the .* release plan/, ["--base", recoveryBase]);
  // Squash merge: a single commit whose parent is the pre-push tip, identical to `versioned`.
  assertValidationRejected(fixture, /git archive .* failed/, ["--base", "no-such-ref"]);

  addChangeset(fixture, "later-patch", [["@lionden/leo-compiler", "patch"]], "Later patch.");
  assertValidationRejected(fixture, /Unreleased changesets remain: later-patch/);
  assertVersioned(fixture, "0.3.1");
  addChangeset(fixture, "later-minor", [["@lionden/leo-compiler", "minor"]], "Later feature.");
  assertVersioned(fixture, "0.4.0");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(
  "Versioning tests passed: --check mode, target policy, release-state validation, guarded 0.3 recovery, changelogs, lockfiles, and later fixed releases.",
);
