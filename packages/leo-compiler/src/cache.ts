import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { DiscoveredUnit } from "./types.js";
import { unitId } from "./types.js";

/**
 * Compute a hash of all inputs that affect compilation of a unit:
 * - All .leo source file contents
 * - Generated program.json content
 * - Hashes of this unit's direct local dependencies (transitivity is automatic
 *   since each dep's hash includes its own deps)
 *
 * @param localDepIds - the canonical IDs of this unit's direct local dependencies
 * @param depHashes - map of already-computed hashes (populated as units compile in topo order)
 */
export function computeUnitHash(
  unit: DiscoveredUnit,
  packageDir: string,
  localDepIds: string[],
  depHashes: Map<string, string>,
): string {
  const hasher = crypto.createHash("sha256");

  // Hash all source files (sorted for determinism)
  for (const relPath of [...unit.allSources].sort()) {
    const absPath = path.join(unit.sourceDir, relPath);
    if (fs.existsSync(absPath)) {
      hasher.update(`file:${relPath}\n`);
      hasher.update(fs.readFileSync(absPath));
    }
  }

  // Hash program.json
  const programJsonPath = path.join(packageDir, "program.json");
  if (fs.existsSync(programJsonPath)) {
    hasher.update("program.json\n");
    hasher.update(fs.readFileSync(programJsonPath));
  }

  // Include only this unit's direct local dependency hashes
  // (each dep hash already includes its own transitive deps)
  for (const depId of [...localDepIds].sort()) {
    const depHash = depHashes.get(depId);
    if (depHash) {
      hasher.update(`dep:${depId}:${depHash}\n`);
    }
  }

  return hasher.digest("hex");
}

/**
 * Check if a unit's compilation is cached (hash matches).
 */
export function isCached(
  cacheDir: string,
  id: string,
  currentHash: string,
): boolean {
  const hashFile = path.join(cacheDir, `${id}.hash`);
  if (!fs.existsSync(hashFile)) return false;
  const storedHash = fs.readFileSync(hashFile, "utf-8").trim();
  return storedHash === currentHash;
}

/**
 * Write the compilation hash to the cache.
 */
export function writeCache(
  cacheDir: string,
  id: string,
  hash: string,
): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${id}.hash`), hash + "\n");
}
