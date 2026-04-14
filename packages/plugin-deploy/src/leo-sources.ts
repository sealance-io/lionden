/**
 * Utility for reading Leo source files from a directory.
 * Extracted to avoid circular dependencies between deploy-task and upgrade-task.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Read all .leo source files from an absolute source directory.
 * Uses the discovered sourceDir (from discoverUnits) rather than
 * deriving the path from the program ID.
 */
export function readLeoSourcesFromDir(sourceDir: string): string {
  if (!fs.existsSync(sourceDir)) return "";

  const sources: string[] = [];
  collectLeoFiles(sourceDir, sources);
  return sources.join("\n");
}

function collectLeoFiles(dir: string, results: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectLeoFiles(fullPath, results);
    } else if (entry.name.endsWith(".leo")) {
      results.push(fs.readFileSync(fullPath, "utf-8"));
    }
  }
}
