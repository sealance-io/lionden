import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCoordinatedBootstrapState,
  assertFixedReleaseGroup,
  COORDINATED_0_2_BOOTSTRAP_VERSIONS,
  loadPublicPackages,
  loadWorkspacePackages,
} from "./release-policy.mjs";

const publicPackages = loadPublicPackages();
const config = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
const fixedGroup = assertFixedReleaseGroup(config, publicPackages);

assert.equal(publicPackages.length, 11);
assert.equal(fixedGroup.length, 11);
assert.ok(!fixedGroup.includes("@lionden/test-internals"));

const bootstrapPackages = Object.entries(COORDINATED_0_2_BOOTSTRAP_VERSIONS).map(
  ([name, version]) => ({ manifest: { name, version } }),
);
assert.doesNotThrow(() => assertCoordinatedBootstrapState(bootstrapPackages));

const unexpectedSkew = structuredClone(bootstrapPackages);
unexpectedSkew[0].manifest.version = "0.1.3";
assert.throws(
  () => assertCoordinatedBootstrapState(unexpectedSkew),
  /Refusing to bootstrap an unexpected public-package skew/,
);

const fixture = mkdtempSync(join(tmpdir(), "release-policy-"));
try {
  mkdirSync(join(fixture, "examples", "private"), { recursive: true });
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({ private: true, workspaces: ["examples/*"] }),
  );
  writeFileSync(
    join(fixture, "examples", "private", "package.json"),
    JSON.stringify({ private: true }),
  );
  assert.equal(loadWorkspacePackages(fixture).length, 1);
  assert.equal(loadPublicPackages(fixture).length, 0);

  writeFileSync(join(fixture, "examples", "private", "package.json"), JSON.stringify({}));
  assert.throws(() => loadPublicPackages(fixture), /needs name and version to be published/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("Release policy test passed: 11 public packages share one fixed group.");
