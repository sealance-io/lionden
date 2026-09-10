import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const COORDINATED_RECOVERY_START_VERSIONS = Object.freeze({
  "@lionden/cli": "0.1.2",
  "@lionden/config": "0.2.0",
  "@lionden/core": "0.2.0",
  "@lionden/leo-compiler": "0.2.0",
  "@lionden/network": "0.2.0",
  "@lionden/plugin-deploy": "0.2.0",
  "@lionden/plugin-leo": "0.1.2",
  "@lionden/plugin-network": "0.1.2",
  "@lionden/plugin-test": "0.1.2",
  "@lionden/testing": "0.1.2",
  "create-lionden": "0.1.1",
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function expandWorkspacePattern(rootDir, pattern) {
  if (!pattern.includes("*")) {
    return [join(rootDir, pattern)];
  }

  if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) {
    throw new Error(`Unsupported workspace pattern: ${pattern}`);
  }

  const parent = join(rootDir, pattern.slice(0, -2));
  if (!existsSync(parent)) return [];

  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
}

export function loadWorkspacePackages(rootDir = process.cwd()) {
  const rootPackage = readJson(join(rootDir, "package.json"));
  if (!Array.isArray(rootPackage.workspaces)) {
    throw new Error("The root package.json must declare workspaces as an array");
  }

  const packages = [];
  const names = new Set();

  for (const pattern of rootPackage.workspaces) {
    for (const workspaceDir of expandWorkspacePattern(rootDir, pattern)) {
      const manifestPath = join(workspaceDir, "package.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = readJson(manifestPath);
      if (typeof manifest.name === "string") {
        if (names.has(manifest.name)) {
          throw new Error(`Duplicate workspace package name: ${manifest.name}`);
        }
        names.add(manifest.name);
      }

      packages.push({
        dir: workspaceDir,
        relativeDir: normalizePath(relative(rootDir, workspaceDir)),
        manifestPath,
        manifest,
      });
    }
  }

  return packages.sort((left, right) => left.relativeDir.localeCompare(right.relativeDir));
}

export function loadPublicPackages(rootDir = process.cwd()) {
  const packages = loadWorkspacePackages(rootDir).filter(
    ({ manifest }) => manifest.private !== true,
  );
  for (const { manifest, relativeDir } of packages) {
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`${relativeDir}/package.json needs name and version to be published`);
    }
  }
  return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export function assertFixedReleaseGroup(config, publicPackages) {
  if (!Array.isArray(config.fixed) || config.fixed.length !== 1) {
    throw new Error("Changesets must define exactly one fixed group for all public packages");
  }

  const expected = publicPackages.map(({ manifest }) => manifest.name).sort();
  const actual = [...config.fixed[0]].sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Changesets fixed group does not match public packages\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`,
    );
  }

  return actual;
}

export function describeVersions(packages) {
  return packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join(", ");
}

export function assertCoordinatedRecoveryState(packages) {
  const actual = Object.fromEntries(
    packages
      .map(({ manifest }) => [manifest.name, manifest.version])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const expected = Object.fromEntries(
    Object.entries(COORDINATED_RECOVERY_START_VERSIONS).sort(([a], [b]) => a.localeCompare(b)),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Refusing to recover from an unexpected public-package skew\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`,
    );
  }
}
