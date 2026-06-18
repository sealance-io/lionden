import * as fs from "node:fs";
import * as path from "node:path";
import { stripCommentsAndStrings } from "./source-scrubber.js";
import type { DiscoveredLibrary, DiscoveredProgram, DiscoveredUnit } from "./types.js";

export class ProgramFolderNameMismatchError extends Error {
  constructor(sourceDir: string, programId: string) {
    const actualDirName = path.basename(sourceDir);
    const expectedDirName = programId.replace(/\.aleo$/, "");
    super(
      `Leo program folder name mismatch: folder "${actualDirName}" declares program "${programId}". ` +
        `Program folder names must match the declared program name. ` +
        `Rename the folder to "${expectedDirName}" or change the "program ..."` +
        ` declaration in main.leo to "program ${actualDirName}.aleo".`,
    );
    this.name = "ProgramFolderNameMismatchError";
  }
}

export class MissingProgramDeclarationError extends Error {
  constructor(entryFile: string) {
    super(
      `Invalid Leo program root: ${entryFile} is missing a program <name>.aleo declaration.`,
    );
    this.name = "MissingProgramDeclarationError";
  }
}

/**
 * Recursively scan `programsDir` for Leo program roots (main.leo) and
 * library roots (lib.leo) at any depth. Returns all discovered compilation units.
 *
 * A directory is a program root if it contains main.leo, or a library root
 * if it contains lib.leo. Once a root is found, its subtree is collected as
 * sources (not scanned for further roots).
 */
export function discoverUnits(programsDir: string): DiscoveredUnit[] {
  const units: DiscoveredUnit[] = [];

  if (!fs.existsSync(programsDir)) {
    return units;
  }

  scanDir(programsDir, units);
  return units;
}

function scanDir(dir: string, units: DiscoveredUnit[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = path.resolve(dir, entry.name);
    const mainLeo = path.join(dirPath, "main.leo");
    const libLeo = path.join(dirPath, "lib.leo");

    if (fs.existsSync(mainLeo)) {
      // Program root — collect sources but don't recurse for more roots
      units.push(discoverProgram(dirPath, mainLeo));
    } else if (fs.existsSync(libLeo)) {
      // Library root — collect sources but don't recurse for more roots
      units.push(discoverLibrary(dirPath, libLeo, entry.name));
    } else {
      // Not a root — recurse deeper
      scanDir(dirPath, units);
    }
  }
}

/**
 * Extract the program ID from a main.leo file by finding the
 * `program <name>.aleo { ... }` or `program <name>.aleo : ...` declaration.
 * Interface syntax after the colon is intentionally left to Leo validation so
 * discovery does not break when new interface-reference forms are introduced.
 */
export function extractProgramId(mainLeoPath: string): string | null {
  const content = stripCommentsAndStrings(fs.readFileSync(mainLeoPath, "utf-8"));
  const match = content.match(/\bprogram\s+([\w]+\.aleo)\s*(?=[:{])/);
  return match ? match[1]! : null;
}

function discoverProgram(sourceDir: string, entryFile: string): DiscoveredProgram {
  const programId = extractProgramId(entryFile);
  // A directory containing main.leo but no parseable `program <name>.aleo`
  // declaration is a layout error, not a unit to skip. Like the folder-name
  // check below, this fails fast at global discovery scope (see comment on
  // validateProgramFolderName): one broken root aborts compile/deploy/upgrade
  // for the whole tree rather than silently dropping the program and surfacing
  // a confusing "program not found" downstream.
  if (!programId) {
    throw new MissingProgramDeclarationError(entryFile);
  }
  validateProgramFolderName(sourceDir, programId);

  return {
    kind: "program",
    programId,
    sourceDir,
    entryFile,
    allSources: collectLeoFiles(sourceDir),
  };
}

// Validation runs here, during discovery, so it is intentionally global: every
// program root under `programsDir` is checked before any `--program` filter or
// dependency-graph pruning is applied (see compilePipeline). A single misnamed
// folder therefore fails compile/deploy/upgrade for the whole tree, not just the
// targeted unit. That fail-fast scope is deliberate — a folder/declaration
// mismatch is a layout error the user should fix regardless of which program is
// being built.
function validateProgramFolderName(sourceDir: string, programId: string): void {
  const actualDirName = path.basename(sourceDir);
  const expectedDirName = programId.replace(/\.aleo$/, "");
  if (actualDirName !== expectedDirName) {
    throw new ProgramFolderNameMismatchError(sourceDir, programId);
  }
}

function discoverLibrary(sourceDir: string, entryFile: string, dirName: string): DiscoveredLibrary {
  return {
    kind: "library",
    name: dirName,
    sourceDir,
    entryFile,
    allSources: collectLeoFiles(sourceDir),
  };
}

/**
 * Recursively collect all .leo files under a directory,
 * returning paths relative to the directory root.
 */
function collectLeoFiles(dir: string, base = ""): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectLeoFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".leo")) {
      results.push(rel);
    }
  }

  return results;
}
