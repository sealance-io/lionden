import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Parse Leo import statements and cross-program calls from .leo source files.
 *
 * Matches:
 * - `import <name>.aleo;`         — explicit import declarations
 * - `<name>.aleo::function()`     — cross-program calls (Leo v4 syntax)
 * - `<name>.aleo/function()`      — cross-program calls (Leo v3.5 syntax)
 *
 * Returns a deduplicated set of external program/library IDs that this
 * set of source files depends on.
 */
export function parseImports(sourceDir: string, relativeFiles: string[]): string[] {
  const imports = new Set<string>();

  // import foo.aleo;
  const importDeclRegex = /import\s+([\w]+\.aleo)\s*;/g;
  // foo.aleo::bar(  — v4
  const crossCallRegex = /([\w]+\.aleo)::/g;
  // foo.aleo/bar(   — v3.5
  const slashCallRegex = /([\w]+\.aleo)\//g;

  for (const relFile of relativeFiles) {
    const absPath = path.join(sourceDir, relFile);
    const content = fs.readFileSync(absPath, "utf-8");

    let match: RegExpExecArray | null;

    importDeclRegex.lastIndex = 0;
    while ((match = importDeclRegex.exec(content)) !== null) {
      imports.add(match[1]!);
    }

    crossCallRegex.lastIndex = 0;
    while ((match = crossCallRegex.exec(content)) !== null) {
      imports.add(match[1]!);
    }

    slashCallRegex.lastIndex = 0;
    while ((match = slashCallRegex.exec(content)) !== null) {
      imports.add(match[1]!);
    }
  }

  return [...imports];
}
