import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRemoteTagTarget,
  parseRemoteTagTargets,
  reconcileReleaseTags,
  releaseTag,
} from "./reconcile-release-tags.mjs";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const dir = mkdtempSync(join(tmpdir(), "release-tags-"));
const repo = join(dir, "repo");
const remote = join(dir, "remote.git");

try {
  mkdirSync(join(repo, ".changeset"), { recursive: true });
  mkdirSync(join(repo, "packages", "public-package"), { recursive: true });
  mkdirSync(join(repo, "packages", "private-package"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  writeFileSync(
    join(repo, "packages", "public-package", "package.json"),
    JSON.stringify({ name: "@scope/public-package", version: "1.0.0" }),
  );
  writeFileSync(
    join(repo, "packages", "private-package", "package.json"),
    JSON.stringify({ name: "private-package", version: "1.0.0", private: true }),
  );
  writeFileSync(
    join(repo, ".changeset", "config.json"),
    JSON.stringify({ fixed: [["@scope/public-package"]] }),
  );

  git(repo, ["init"]);
  git(repo, ["config", "user.email", "release-test@example.com"]);
  git(repo, ["config", "user.name", "Release Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "release"]);
  git(dir, ["init", "--bare", remote]);
  git(repo, ["remote", "add", "origin", remote]);

  const gitHead = git(repo, ["rev-parse", "HEAD"]);
  const requestSignals = [];
  const fetchImpl = async (_url, options) => {
    requestSignals.push(options.signal);
    return new Response(
      JSON.stringify({
        name: "@scope/public-package",
        versions: {
          // Historical metadata is intentionally irrelevant to current-release reconciliation.
          "0.9.0": { name: "@scope/public-package", version: "0.9.0" },
          "1.0.0": { name: "@scope/public-package", version: "1.0.0", gitHead },
        },
      }),
      { status: 200 },
    );
  };
  const outputPath = join(dir, "release-tags.txt");

  const tags = await reconcileReleaseTags({ rootDir: repo, outputPath, push: true, fetchImpl });
  assert.deepEqual(tags, ["@scope/public-package@1.0.0"]);
  assert.equal(readFileSync(outputPath, "utf8"), "@scope/public-package@1.0.0\n");
  assert.equal(
    git(repo, ["ls-remote", "--tags", "origin", "refs/tags/@scope/public-package@1.0.0"]),
    `${gitHead}\trefs/tags/@scope/public-package@1.0.0`,
  );
  assert.ok(requestSignals.every((signal) => signal instanceof AbortSignal));

  await reconcileReleaseTags({ rootDir: repo, push: false, fetchImpl });

  let nowMs = 0;
  let replicationAttempts = 0;
  const retryDelays = [];
  const laggingFetch = async (...args) => {
    replicationAttempts++;
    if (replicationAttempts > 1) return fetchImpl(...args);
    return new Response(
      JSON.stringify({
        name: "@scope/public-package",
        versions: {
          "0.9.0": { name: "@scope/public-package", version: "0.9.0", gitHead },
        },
      }),
      { status: 200 },
    );
  };
  await reconcileReleaseTags({
    rootDir: repo,
    push: false,
    fetchImpl: laggingFetch,
    registryTimeoutMs: 100,
    registryRequestTimeoutMs: 20,
    registryRetryDelayMs: 10,
    sleepImpl: async (delayMs) => {
      retryDelays.push(delayMs);
      nowMs += delayMs;
    },
    nowImpl: () => nowMs,
  });
  assert.equal(replicationAttempts, 2);
  assert.deepEqual(retryDelays, [10]);

  nowMs = 0;
  const timeoutDelays = [];
  const staleFetch = async () =>
    new Response(
      JSON.stringify({
        name: "@scope/public-package",
        versions: {
          "0.9.0": { name: "@scope/public-package", version: "0.9.0", gitHead },
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    reconcileReleaseTags({
      rootDir: repo,
      push: false,
      fetchImpl: staleFetch,
      registryTimeoutMs: 25,
      registryRequestTimeoutMs: 20,
      registryRetryDelayMs: 10,
      sleepImpl: async (delayMs) => {
        timeoutDelays.push(delayMs);
        nowMs += delayMs;
      },
      nowImpl: () => nowMs,
    }),
    /npm registry visibility timed out after 0\.025s \(2 polls\)/,
  );
  assert.deepEqual(timeoutDelays, [10, 15]);

  const invalidCurrentFetch = async () =>
    new Response(
      JSON.stringify({
        name: "@scope/public-package",
        versions: {
          "1.0.0": { name: "@scope/public-package", version: "1.0.0" },
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    reconcileReleaseTags({ rootDir: repo, push: false, fetchImpl: invalidCurrentFetch }),
    /npm metadata for @scope\/public-package@1\.0\.0 has no valid gitHead/,
  );

  await assert.rejects(
    reconcileReleaseTags({ rootDir: repo, push: false, fetchImpl, registryTimeoutMs: 0 }),
    /registryTimeoutMs must be a positive number/,
  );
  await assert.rejects(
    reconcileReleaseTags({ rootDir: repo, push: false, fetchImpl, registryRequestTimeoutMs: 0 }),
    /registryRequestTimeoutMs must be a positive number/,
  );

  writeFileSync(join(repo, "README.md"), "later commit\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "later"]);
  const laterGitHead = git(repo, ["rev-parse", "HEAD"]);
  const mismatchedCurrentFetch = async () =>
    new Response(
      JSON.stringify({
        name: "@scope/public-package",
        versions: {
          "1.0.0": {
            name: "@scope/public-package",
            version: "1.0.0",
            gitHead: laterGitHead,
          },
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    reconcileReleaseTags({ rootDir: repo, push: true, fetchImpl: mismatchedCurrentFetch }),
    /Remote tag .* but npm records/,
  );

  const newPackages = Array.from({ length: 10 }, (_, index) => `@scope/pkg-${index}`);
  const packageNames = [...newPackages, "@scope/public-package"];
  for (const [index, name] of newPackages.entries()) {
    const packageDir = join(repo, "packages", `pkg-${index}`);
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  writeFileSync(join(repo, ".changeset", "config.json"), JSON.stringify({ fixed: [packageNames] }));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "add release packages"]);
  const newGitHead = git(repo, ["rev-parse", "HEAD"]);
  const publishedPackument = (name) =>
    Response.json({
      name,
      versions: {
        "1.0.0": {
          name,
          version: "1.0.0",
          gitHead: name === "@scope/public-package" ? gitHead : newGitHead,
        },
      },
    });
  const originalRefs = git(repo, ["ls-remote", "--tags", "origin"]);
  const summaryPath = join(dir, "step-summary.md");
  const slowPackage = newPackages[0];
  const unavailablePackage = newPackages[1];
  nowMs = 0;
  await assert.rejects(
    reconcileReleaseTags({
      rootDir: repo,
      push: true,
      summaryPath,
      fetchImpl: async (url) => {
        const name = decodeURIComponent(new URL(url).pathname.slice(1));
        if (name === slowPackage) return Response.json({ name, versions: {} });
        if (name === unavailablePackage) return new Response(null, { status: 503 });
        return publishedPackument(name);
      },
      registryTimeoutMs: 3000,
      nowImpl: () => nowMs,
      sleepImpl: async (delayMs) => {
        nowMs += delayMs;
      },
    }),
    /npm registry visibility timed out after 3s/,
  );
  const summary = readFileSync(summaryPath, "utf8");
  assert.deepEqual(summary.match(/^- `[^`]+`/gm), [
    `- \`${slowPackage}@1.0.0\``,
    `- \`${unavailablePackage}@1.0.0\``,
  ]);
  assert.match(summary, /not visible in the npm packument/);
  assert.match(summary, /503/);
  assert.match(summary, /manually dispatch Release - Publish from main/);
  assert.equal(git(repo, ["ls-remote", "--tags", "origin"]), originalRefs);

  nowMs = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const requested = [];
  let refsWhenSlowPackageVisible;
  const concurrentFetch = async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    requested.push(name);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight--;
    if (name === slowPackage) {
      if (nowMs < 6 * 60_000) return Response.json({ name, versions: {} });
      // Recorded here and asserted after the run: a throw inside fetchImpl would be retried.
      refsWhenSlowPackageVisible = git(repo, ["ls-remote", "--tags", "origin"]);
    }
    return publishedPackument(name);
  };
  assert.deepEqual(
    await reconcileReleaseTags({
      rootDir: repo,
      push: true,
      fetchImpl: concurrentFetch,
      nowImpl: () => nowMs,
      sleepImpl: async (delayMs) => {
        nowMs += delayMs;
      },
    }),
    packageNames.map((name) => `${name}@1.0.0`),
  );
  // The ten visible versions must not have caused any partial tag push.
  assert.equal(refsWhenSlowPackageVisible, originalRefs);
  assert.equal(maxInFlight, 11);
  assert.deepEqual(
    requested.filter((name) => name !== slowPackage),
    packageNames.filter((name) => name !== slowPackage),
  );
  assert.equal(git(repo, ["ls-remote", "--tags", "origin"]).split("\n").length, 11);

  assert.equal(releaseTag({ name: "@scope/pkg", version: "2.3.4" }), "@scope/pkg@2.3.4");
  assert.equal(
    parseRemoteTagTarget(
      `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/pkg@1.0.0\n` +
        `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/pkg@1.0.0^{}`,
      "pkg@1.0.0",
    ),
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.deepEqual(
    [
      ...parseRemoteTagTargets(
        `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/pkg@1.0.0\n` +
          `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/pkg@1.0.0^{}\n` +
          `cccccccccccccccccccccccccccccccccccccccc\trefs/tags/pkg@2.0.0`,
      ),
    ],
    [
      ["pkg@1.0.0", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      ["pkg@2.0.0", "cccccccccccccccccccccccccccccccccccccccc"],
    ],
  );

  console.log("Release tag reconciliation tests passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
