import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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
      if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
        throw new Error(`${normalizePath(relative(rootDir, manifestPath))} needs name and version`);
      }
      if (names.has(manifest.name)) {
        throw new Error(`Duplicate workspace package name: ${manifest.name}`);
      }
      names.add(manifest.name);

      packages.push({
        dir: workspaceDir,
        relativeDir: normalizePath(relative(rootDir, workspaceDir)),
        manifestPath,
        manifest,
      });
    }
  }

  return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export function loadPublicPackages(rootDir = process.cwd()) {
  return loadWorkspacePackages(rootDir).filter(({ manifest }) => manifest.private !== true);
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
