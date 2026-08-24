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
  let direct;
  let peeled;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [commit, ref] = line.split(/\s+/, 2);
    if (ref === `refs/tags/${tag}`) direct = commit;
    if (ref === `refs/tags/${tag}^{}`) peeled = commit;
  }

  return peeled ?? direct;
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

  return Object.entries(metadata.versions)
    .map(([version, release]) => {
      if (release.name !== name || release.version !== version) {
        throw new Error(`npm returned inconsistent release metadata for ${name}@${version}`);
      }
      if (typeof release.gitHead !== "string" || !COMMIT_REGEXP.test(release.gitHead)) {
        throw new Error(`npm metadata for ${name}@${version} has no valid gitHead`);
      }
      return { name, version, gitHead: release.gitHead };
    })
    .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }));
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function publishedReleases(
  name,
  expectedVersion,
  registryUrl,
  fetchImpl,
  { attempts, retryDelayMs, sleepImpl },
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
      const releases = await fetchPublishedReleases(name, registryUrl, fetchImpl);
      if (!releases.some(({ version }) => version === expectedVersion)) {
        throw new RetryableRegistryError(
          `${name}@${expectedVersion} is not visible in the npm packument yet`,
        );
      }
      return releases;
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

function remoteTagTarget(rootDir, remote, tag) {
  const output = runGit(
    rootDir,
    ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { allowFailure: false },
  );
  return parseRemoteTagTarget(output, tag);
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
  push = false,
  fetchImpl = globalThis.fetch,
  registryAttempts = DEFAULT_REGISTRY_ATTEMPTS,
  registryRetryDelayMs = DEFAULT_REGISTRY_RETRY_DELAY_MS,
  sleepImpl = wait,
} = {}) {
  const config = JSON.parse(await readFile(join(rootDir, ".changeset", "config.json"), "utf8"));
  const packages = loadPublicPackages(rootDir);
  assertFixedReleaseGroup(config, packages);

  const tags = [];
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
      },
    );

    for (const pkg of releases) {
      const tag = releaseTag(pkg);
      const { gitHead } = pkg;
      if (!gitSucceeds(rootDir, ["cat-file", "-e", `${gitHead}^{commit}`])) {
        throw new Error(
          `${tag} points to npm gitHead ${gitHead}, which is absent from this checkout`,
        );
      }

      const remoteTarget = remoteTagTarget(rootDir, remote, tag);
      if (remoteTarget && remoteTarget !== gitHead) {
        throw new Error(`Remote tag ${tag} points to ${remoteTarget}, but npm records ${gitHead}`);
      }

      if (!remoteTarget) {
        if (!push) throw new Error(`Remote tag ${tag} is missing (rerun with --push to repair it)`);

        const localTarget = localTagTarget(rootDir, tag);
        if (localTarget && localTarget !== gitHead) {
          throw new Error(`Local tag ${tag} points to ${localTarget}, but npm records ${gitHead}`);
        }
        if (!localTarget) runGit(rootDir, ["tag", tag, gitHead]);

        console.log(`Pushing missing tag ${tag} at ${gitHead}`);
        runGit(rootDir, ["push", remote, `refs/tags/${tag}:refs/tags/${tag}`]);
      }

      const verifiedTarget = remoteTagTarget(rootDir, remote, tag);
      if (verifiedTarget !== gitHead) {
        throw new Error(
          `Remote verification failed for ${tag}: expected ${gitHead}, got ${verifiedTarget}`,
        );
      }

      console.log(`Verified ${tag} at ${gitHead}`);
      tags.push(tag);
    }
  }

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
