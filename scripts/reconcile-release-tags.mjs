import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertFixedReleaseGroup, loadPublicPackages } from "./release-policy.mjs";

const COMMIT_REGEXP = /^[0-9a-f]{40}$/;
const DEFAULT_REGISTRY_TIMEOUT_MS = 25 * 60_000;
const DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_REGISTRY_RETRY_DELAY_MS = 2_000;
const MAX_REGISTRY_RETRY_DELAY_MS = 15_000;

class RetryableRegistryError extends Error {}

function runGit(rootDir, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", allowFailure ? "pipe" : "inherit"],
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function gitSucceeds(rootDir, args) {
  try {
    execFileSync("git", args, { cwd: rootDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function releaseTag({ name, version }) {
  return `${name}@${version}`;
}

export function parseRemoteTagTarget(output, tag) {
  return parseRemoteTagTargets(output).get(tag);
}

export function parseRemoteTagTargets(output) {
  const direct = new Map();
  const peeled = new Map();

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [commit, ref] = line.split(/\s+/, 2);
    if (!ref?.startsWith("refs/tags/")) continue;
    if (ref.endsWith("^{}")) peeled.set(ref.slice("refs/tags/".length, -3), commit);
    else direct.set(ref.slice("refs/tags/".length), commit);
  }

  return new Map([...direct, ...peeled]);
}

async function fetchPublishedRelease(name, version, registryUrl, fetchImpl, requestTimeoutMs) {
  const packageUrl = `${registryUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetchImpl(packageUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new RetryableRegistryError(`npm metadata request failed for ${name}`, { cause: error });
  }
  if (!response.ok) {
    const message = `npm metadata lookup failed for ${name}: ${response.status}`;
    if (response.status === 404 || response.status === 408 || response.status === 429) {
      throw new RetryableRegistryError(message);
    }
    if (response.status >= 500) throw new RetryableRegistryError(message);
    throw new Error(message);
  }

  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    throw new RetryableRegistryError(`npm returned unreadable metadata for ${name}`, {
      cause: error,
    });
  }
  if (metadata.name !== name || !metadata.versions || typeof metadata.versions !== "object") {
    throw new Error(`npm returned unexpected metadata for ${name}`);
  }

  const release = metadata.versions[version];
  if (!release) {
    throw new RetryableRegistryError(`${name}@${version} is not visible in the npm packument yet`);
  }
  if (release.name !== name || release.version !== version) {
    throw new Error(`npm returned inconsistent release metadata for ${name}@${version}`);
  }
  if (typeof release.gitHead !== "string" || !COMMIT_REGEXP.test(release.gitHead)) {
    throw new Error(`npm metadata for ${name}@${version} has no valid gitHead`);
  }
  return { name, version, gitHead: release.gitHead };
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForPublishedReleases(
  packages,
  {
    registryUrl,
    fetchImpl,
    timeoutMs,
    requestTimeoutMs,
    retryDelayMs,
    sleepImpl,
    nowImpl,
    summaryPath,
  },
) {
  const lookups = packages.map(({ manifest }) => ({
    manifest,
    release: undefined,
    lastError: undefined,
  }));
  let pending = lookups;
  const startedAt = nowImpl();
  const deadlineMs = startedAt + timeoutMs;
  let delayMs = Math.min(retryDelayMs, MAX_REGISTRY_RETRY_DELAY_MS);
  let attempts = 0;
  while (pending.length > 0 && nowImpl() < deadlineMs) {
    attempts++;
    const requestBudgetMs = Math.min(requestTimeoutMs, Math.max(1, deadlineMs - nowImpl()));
    try {
      await Promise.all(
        pending.map(async (lookup) => {
          const { name, version } = lookup.manifest;
          try {
            lookup.release = await fetchPublishedRelease(
              name,
              version,
              registryUrl,
              fetchImpl,
              requestBudgetMs,
            );
          } catch (error) {
            if (!(error instanceof RetryableRegistryError)) throw error;
            lookup.lastError = error.message;
          }
        }),
      );
    } catch (error) {
      if (summaryPath) {
        appendFileSync(
          summaryPath,
          `## npm registry visibility\n\nnpm registry lookup failed without retry: ${error.message}\n`,
        );
      }
      throw error;
    }

    pending = pending.filter((lookup) => !lookup.release);
    const remainingMs = deadlineMs - nowImpl();
    if (pending.length === 0 || remainingMs <= 0) break;
    const waitMs = Math.min(delayMs, remainingMs);
    const reasons = pending.map(
      ({ manifest, lastError }) => `${releaseTag(manifest)} (${lastError})`,
    );
    console.warn(`Retrying npm metadata for ${reasons.join(", ")} in ${waitMs}ms`);
    await sleepImpl(waitMs);
    delayMs = Math.min(delayMs * 2, MAX_REGISTRY_RETRY_DELAY_MS);
  }

  const elapsedSeconds = (nowImpl() - startedAt) / 1000;
  if (pending.length > 0) {
    const report = [
      `npm registry visibility timed out after ${elapsedSeconds}s (${attempts} polls). Outstanding versions:`,
      "",
      ...pending.map(
        ({ manifest, lastError }) =>
          `- \`${releaseTag(manifest)}\` — ${lastError ?? "deadline expired"}`,
      ),
      "",
      "Check the original publish result and npm maintainer notifications. After a successful publish, " +
        "wait for every version to appear. While main still declares those versions, manually dispatch " +
        "Release - Publish from main to repair tags and GitHub Releases without publishing again.",
    ].join("\n");
    if (summaryPath) appendFileSync(summaryPath, `## npm registry visibility\n\n${report}\n`);
    throw new Error(report);
  }
  console.log(`Verified npm metadata for ${lookups.length} package versions in ${elapsedSeconds}s`);
  return lookups.map(({ release }) => release);
}

function argumentValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function remoteTagTargets(rootDir, remote) {
  return parseRemoteTagTargets(
    runGit(rootDir, ["ls-remote", "--tags", remote], { allowFailure: false }),
  );
}

function localTagTarget(rootDir, tag) {
  return runGit(rootDir, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], {
    allowFailure: true,
  });
}

export async function reconcileReleaseTags({
  rootDir = process.cwd(),
  remote = "origin",
  registryUrl = "https://registry.npmjs.org",
  outputPath,
  summaryPath,
  push = false,
  fetchImpl = globalThis.fetch,
  registryTimeoutMs = DEFAULT_REGISTRY_TIMEOUT_MS,
  registryRequestTimeoutMs = DEFAULT_REGISTRY_REQUEST_TIMEOUT_MS,
  registryRetryDelayMs = DEFAULT_REGISTRY_RETRY_DELAY_MS,
  sleepImpl = wait,
  nowImpl = Date.now,
} = {}) {
  const config = JSON.parse(await readFile(join(rootDir, ".changeset", "config.json"), "utf8"));
  const packages = loadPublicPackages(rootDir);
  assertFixedReleaseGroup(config, packages);

  if (!Number.isFinite(registryTimeoutMs) || registryTimeoutMs <= 0) {
    throw new Error("registryTimeoutMs must be a positive number");
  }
  if (!Number.isFinite(registryRequestTimeoutMs) || registryRequestTimeoutMs <= 0) {
    throw new Error("registryRequestTimeoutMs must be a positive number");
  }
  if (!Number.isFinite(registryRetryDelayMs) || registryRetryDelayMs < 0) {
    throw new Error("registryRetryDelayMs must be a non-negative number");
  }

  const expectedTags = [];
  const missingTags = [];
  const releases = await waitForPublishedReleases(packages, {
    registryUrl,
    fetchImpl,
    timeoutMs: registryTimeoutMs,
    requestTimeoutMs: registryRequestTimeoutMs,
    retryDelayMs: registryRetryDelayMs,
    sleepImpl,
    nowImpl,
    summaryPath,
  });
  // Snapshot remote tags only after the registry wait, which can last many minutes.
  let verifiedTargets = remoteTagTargets(rootDir, remote);

  for (const pkg of releases) {
    const tag = releaseTag(pkg);
    const { gitHead } = pkg;
    const remoteTarget = verifiedTargets.get(tag);
    if (remoteTarget && remoteTarget !== gitHead) {
      throw new Error(`Remote tag ${tag} points to ${remoteTarget}, but npm records ${gitHead}`);
    }
    if (remoteTarget) {
      expectedTags.push({ tag, gitHead });
      continue;
    }

    if (!gitSucceeds(rootDir, ["cat-file", "-e", `${gitHead}^{commit}`])) {
      throw new Error(
        `${tag} points to npm gitHead ${gitHead}, which is absent from this checkout`,
      );
    }
    if (!push) throw new Error(`Remote tag ${tag} is missing (rerun with --push to repair it)`);

    const localTarget = localTagTarget(rootDir, tag);
    if (localTarget && localTarget !== gitHead) {
      throw new Error(`Local tag ${tag} points to ${localTarget}, but npm records ${gitHead}`);
    }
    missingTags.push({ tag, gitHead, createLocal: !localTarget });
    expectedTags.push({ tag, gitHead });
  }

  if (missingTags.length > 0) {
    for (const { tag, gitHead, createLocal } of missingTags) {
      if (createLocal) runGit(rootDir, ["tag", tag, gitHead]);
      console.log(`Prepared missing tag ${tag} at ${gitHead}`);
    }
    runGit(rootDir, [
      "push",
      remote,
      ...missingTags.map(({ tag }) => `refs/tags/${tag}:refs/tags/${tag}`),
    ]);
    verifiedTargets = remoteTagTargets(rootDir, remote);
  }

  for (const { tag, gitHead } of expectedTags) {
    const verifiedTarget = verifiedTargets.get(tag);
    if (verifiedTarget !== gitHead) {
      throw new Error(
        `Remote verification failed for ${tag}: expected ${gitHead}, got ${verifiedTarget}`,
      );
    }
    console.log(`Verified ${tag} at ${gitHead}`);
  }

  const tags = expectedTags.map(({ tag }) => tag);
  if (outputPath) writeFileSync(outputPath, `${tags.join("\n")}\n`);
  return tags;
}

function parseArgs(args) {
  const options = { push: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--push") options.push = true;
    else if (arg === "--output") options.outputPath = argumentValue(args, index++, arg);
    else if (arg === "--summary") options.summaryPath = argumentValue(args, index++, arg);
    else if (arg === "--registry-timeout-ms") {
      const value = argumentValue(args, index++, arg);
      // AbortSignal.timeout() rejects fractional delays, so accept only positive safe integers.
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${arg} must be a positive integer number of milliseconds`);
      }
      options.registryTimeoutMs = Number(value);
    } else if (arg === "--remote") options.remote = argumentValue(args, index++, arg);
    else if (arg === "--registry-url") options.registryUrl = argumentValue(args, index++, arg);
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await reconcileReleaseTags(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
