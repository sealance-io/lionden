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
    /npm metadata for @scope\/public-package@1\.0\.0 was not ready before the shared registry deadline after 2 attempts/,
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

  mkdirSync(join(repo, "packages", "second-package"));
  writeFileSync(
    join(repo, "packages", "second-package", "package.json"),
    JSON.stringify({ name: "@scope/second-package", version: "1.0.0" }),
  );
  writeFileSync(
    join(repo, ".changeset", "config.json"),
    JSON.stringify({ fixed: [["@scope/public-package", "@scope/second-package"]] }),
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "add second package"]);
  const secondGitHead = git(repo, ["rev-parse", "HEAD"]);
  let inFlight = 0;
  let maxInFlight = 0;
  const concurrentFetch = async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight--;
    return new Response(
      JSON.stringify({
        name,
        versions: {
          "1.0.0": {
            name,
            version: "1.0.0",
            gitHead: name === "@scope/public-package" ? gitHead : secondGitHead,
          },
        },
      }),
      { status: 200 },
    );
  };
  assert.deepEqual(
    await reconcileReleaseTags({ rootDir: repo, push: true, fetchImpl: concurrentFetch }),
    ["@scope/public-package@1.0.0", "@scope/second-package@1.0.0"],
  );
  assert.equal(maxInFlight, 2);

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
