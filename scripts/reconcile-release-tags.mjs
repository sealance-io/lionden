import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertFixedReleaseGroup, loadPublicPackages } from "./release-policy.mjs";

const COMMIT_REGEXP = /^[0-9a-f]{40}$/;
const DEFAULT_REGISTRY_ATTEMPTS = 7;
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

async function fetchPublishedReleases(name, registryUrl, fetchImpl) {
  const packageUrl = `${registryUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetchImpl(packageUrl, { headers: { accept: "application/json" } });
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

  return metadata;
}

function ignoreHistoricalFailure({
  tag,
  version,
  expectedVersion,
  error,
  exceptions,
  usedExceptions,
}) {
  const reason = exceptions.get(tag);
  if (!reason || version === expectedVersion) return false;
  usedExceptions.add(tag);
  console.warn(`Skipping historical ${tag}: ${reason} (${error.message})`);
  return true;
}

function validatePublishedReleases(name, expectedVersion, metadata, exceptions, usedExceptions) {
  const releases = [];
  for (const [version, release] of Object.entries(metadata.versions)) {
    const tag = releaseTag({ name, version });
    try {
      if (release.name !== name || release.version !== version) {
        throw new Error(`npm returned inconsistent release metadata for ${name}@${version}`);
      }
      if (typeof release.gitHead !== "string" || !COMMIT_REGEXP.test(release.gitHead)) {
        throw new Error(`npm metadata for ${name}@${version} has no valid gitHead`);
      }
      releases.push({ name, version, gitHead: release.gitHead });
    } catch (error) {
      if (
        !ignoreHistoricalFailure({
          tag,
          version,
          expectedVersion,
          error,
          exceptions,
          usedExceptions,
        })
      ) {
        throw error;
      }
    }
  }
  return releases;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function publishedReleases(
  name,
  expectedVersion,
  registryUrl,
  fetchImpl,
  { attempts, retryDelayMs, sleepImpl, exceptions, usedExceptions },
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("registryAttempts must be a positive integer");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("registryRetryDelayMs must be a non-negative number");
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const metadata = await fetchPublishedReleases(name, registryUrl, fetchImpl);
      if (!Object.hasOwn(metadata.versions, expectedVersion)) {
        throw new RetryableRegistryError(
          `${name}@${expectedVersion} is not visible in the npm packument yet`,
        );
      }
      return validatePublishedReleases(name, expectedVersion, metadata, exceptions, usedExceptions);
    } catch (error) {
      if (!(error instanceof RetryableRegistryError)) throw error;
      lastError = error;
      if (attempt === attempts) break;

      const delayMs = Math.min(retryDelayMs * 2 ** (attempt - 1), MAX_REGISTRY_RETRY_DELAY_MS);
      console.warn(
        `${error.message}; retrying npm metadata (${attempt + 1}/${attempts}) in ${delayMs}ms`,
      );
      await sleepImpl(delayMs);
    }
  }

  const attemptLabel = `${attempts} registry attempt${attempts === 1 ? "" : "s"}`;
  throw new Error(
    `npm metadata for ${name}@${expectedVersion} was not ready after ${attemptLabel}: ${lastError.message}`,
    { cause: lastError },
  );
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

async function loadReleaseExceptions(rootDir) {
  const path = join(rootDir, ".changeset", "release-tag-exceptions.json");
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw new Error(`Could not read ${path}: ${error.message}`, { cause: error });
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${path} must contain an object mapping release tags to reasons`);
  }

  const exceptions = new Map();
  for (const [tag, reason] of Object.entries(value)) {
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error(`${path} needs a non-empty reason for ${tag}`);
    }
    exceptions.set(tag, reason.trim());
  }
  return exceptions;
}

export async function reconcileReleaseTags({
  rootDir = process.cwd(),
  remote = "origin",
  registryUrl = "https://registry.npmjs.org",
  outputPath,
  push = false,
  fetchImpl = globalThis.fetch,
  registryAttempts = DEFAULT_REGISTRY_ATTEMPTS,
  registryRetryDelayMs = DEFAULT_REGISTRY_RETRY_DELAY_MS,
  sleepImpl = wait,
} = {}) {
  const config = JSON.parse(await readFile(join(rootDir, ".changeset", "config.json"), "utf8"));
  const packages = loadPublicPackages(rootDir);
  assertFixedReleaseGroup(config, packages);

  const exceptions = await loadReleaseExceptions(rootDir);
  const usedExceptions = new Set();
  const expectedTags = [];
  const missingTags = [];
  let verifiedTargets = remoteTagTargets(rootDir, remote);

  for (const { manifest } of packages) {
    const releases = await publishedReleases(
      manifest.name,
      manifest.version,
      registryUrl,
      fetchImpl,
      {
        attempts: registryAttempts,
        retryDelayMs: registryRetryDelayMs,
        sleepImpl,
        exceptions,
        usedExceptions,
      },
    );

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
        const error = new Error(
          `${tag} points to npm gitHead ${gitHead}, which is absent from this checkout`,
        );
        if (
          ignoreHistoricalFailure({
            tag,
            version: pkg.version,
            expectedVersion: manifest.version,
            error,
            exceptions,
            usedExceptions,
          })
        ) {
          continue;
        }
        throw error;
      }

      if (!push) throw new Error(`Remote tag ${tag} is missing (rerun with --push to repair it)`);

      const localTarget = localTagTarget(rootDir, tag);
      if (localTarget && localTarget !== gitHead) {
        throw new Error(`Local tag ${tag} points to ${localTarget}, but npm records ${gitHead}`);
      }
      missingTags.push({ tag, gitHead, createLocal: !localTarget });
      expectedTags.push({ tag, gitHead });
    }
  }

  const unusedExceptions = [...exceptions.keys()].filter((tag) => !usedExceptions.has(tag));
  if (unusedExceptions.length > 0) {
    throw new Error(`Unused release-tag exceptions: ${unusedExceptions.join(", ")}`);
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
    else if (arg === "--remote") options.remote = argumentValue(args, index++, arg);
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
