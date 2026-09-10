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
import { COORDINATED_0_2_BOOTSTRAP_VERSIONS, loadPublicPackages } from "./release-policy.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(rootDir, ".changeset/config.json"), "utf8"));
const historicalVersions = COORDINATED_0_2_BOOTSTRAP_VERSIONS;
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
  const init = spawnSync("git", ["init", "--quiet"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

function runVersioning(dir) {
  return spawnSync(process.execPath, [join(rootDir, "scripts/version-packages.mjs")], {
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

function assertRejectedWithoutWrites(dir, message) {
  const before = snapshot(dir);
  const result = runVersioning(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, message);
  assert.deepEqual(snapshot(dir), before);
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

  const cliPath = join(fixture, "packages/cli/package.json");
  const cli = JSON.parse(readFileSync(cliPath, "utf8"));
  writeJson(cliPath, { ...cli, version: "0.1.3" });
  assertRejectedWithoutWrites(fixture, /Refusing to bootstrap an unexpected public-package skew/);
  writeJson(cliPath, cli);

  addChangeset(
    fixture,
    "compiler-feature",
    [["@lionden/leo-compiler", "major"]],
    "Breaking change.",
  );
  assertRejectedWithoutWrites(fixture, /must converge at 0\.3\.0, not 1\.0\.0/);
  addChangeset(
    fixture,
    "compiler-feature",
    [["@lionden/leo-compiler", "minor"]],
    "Allow version metadata.",
  );

  assertVersioned(fixture, "0.3.0");
  const compilerChangelog = readFileSync(
    join(fixture, "packages/leo-compiler/CHANGELOG.md"),
    "utf8",
  );
  assert.ok(compilerChangelog.includes("Preserve metadata."));
  assert.ok(compilerChangelog.includes("Allow version metadata."));
  assertRejectedWithoutWrites(fixture, /No unreleased changesets found/);

  addChangeset(fixture, "later-patch", [["@lionden/leo-compiler", "patch"]], "Later patch.");
  assertVersioned(fixture, "0.3.1");
  addChangeset(fixture, "later-minor", [["@lionden/leo-compiler", "minor"]], "Later feature.");
  assertVersioned(fixture, "0.4.0");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(
  "Versioning tests passed: guarded 0.3 recovery, changelogs, lockfiles, and later fixed releases.",
);
