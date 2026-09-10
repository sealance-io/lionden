import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleReleasePlan } from "@changesets/assemble-release-plan";
import { readConfig } from "@changesets/config";
import { readPreState } from "@changesets/pre";
import { readChangesets } from "@changesets/read";
import { getPackages } from "@manypkg/get-packages";
import {
  assertChangesetTargets,
  assertCoordinatedRecoveryState,
  assertFixedReleaseGroup,
  loadPublicPackages,
} from "./release-policy.mjs";

/** The one version the partial-0.2 recovery is allowed to converge at. */
export const RECOVERY_TARGET_VERSION = "0.3.0";

/**
 * Reads everything a release plan needs from `rootDir` and validates the committed Changesets
 * config against the public fixed group. Performs no writes.
 */
export async function loadReleaseContext(rootDir) {
  // Prerelease mode is rejected outright, whatever the file contains: mode "exit" is still pre
  // state, malformed JSON would make the Changesets reader throw, and a null body is normalized
  // by the reader to "no pre state". Enabling it is an explicit policy change, not a file.
  if (existsSync(join(rootDir, ".changeset", "pre.json"))) {
    throw new Error(
      "Prerelease mode is not supported by the release policy: remove .changeset/pre.json",
    );
  }
  const writtenConfig = JSON.parse(
    readFileSync(join(rootDir, ".changeset", "config.json"), "utf8"),
  );
  const publicPackages = loadPublicPackages(rootDir);
  const publicNames = assertFixedReleaseGroup(writtenConfig, publicPackages);
  const needsRecovery = new Set(publicPackages.map(({ manifest }) => manifest.version)).size !== 1;

  const packages = await getPackages(rootDir);
  const configResult = await readConfig(rootDir, packages);
  if (configResult.errors) {
    throw new Error(`Invalid Changesets config:\n${configResult.errors.join("\n")}`);
  }
  const [changesets, preState] = await Promise.all([
    readChangesets(rootDir),
    readPreState(rootDir),
  ]);

  return {
    rootDir,
    publicPackages,
    publicNames,
    needsRecovery,
    packages,
    releaseConfig: configResult.config,
    configWarnings: configResult.warnings,
    changesets,
    preState,
  };
}

/**
 * Assembles the release plan for a loaded context and enforces release policy: only public
 * targets, one converged public version, and the fixed recovery target while manifests are
 * still skewed. Performs no writes.
 */
export function planRelease(context) {
  const {
    publicPackages,
    publicNames,
    needsRecovery,
    packages,
    releaseConfig,
    changesets,
    preState,
  } = context;
  if (needsRecovery) assertCoordinatedRecoveryState(publicPackages);
  assertChangesetTargets(changesets, publicNames);

  const releasePlan = assembleReleasePlan(changesets, packages, releaseConfig, preState);
  const plannedVersions = new Map(
    publicPackages.map(({ manifest }) => [manifest.name, manifest.version]),
  );
  for (const release of releasePlan.releases) {
    if (plannedVersions.has(release.name)) plannedVersions.set(release.name, release.newVersion);
  }
  const plannedVersionSet = new Set(plannedVersions.values());
  if (plannedVersionSet.size !== 1) {
    throw new Error(
      `Release plan does not converge public packages: ${[...plannedVersions].map(([name, version]) => `${name}@${version}`).join(", ")}`,
    );
  }
  const [plannedVersion] = plannedVersionSet;
  if (needsRecovery && plannedVersion !== RECOVERY_TARGET_VERSION) {
    throw new Error(
      `The coordinated recovery must converge at ${RECOVERY_TARGET_VERSION}, not ${plannedVersion}`,
    );
  }
  return { releasePlan, plannedVersion };
}
