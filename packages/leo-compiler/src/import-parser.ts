import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Replace comment and string-literal spans in Leo source with whitespace so
 * the import regexes below only ever see real code. A `<name>.aleo` token that
 * appears in a doc comment (`// see token.aleo::transfer`) or an annotation
 * string (`@checksum(mapping="x.aleo::m")`) would otherwise be detected as a
 * phantom dependency.
 *
 * Single forward scan over the source. Inside a line comment, a block comment,
 * or a string (`"…"` / `'…'`) every character except newlines is replaced by a
 * space, so offsets and line numbers are preserved while no `.aleo` token can
 * survive. Leo string/identifier literals carry no escape sequences and no
 * newlines in practice (only addresses, identifiers, and mapping refs), so no
 * escape handling is needed. An unterminated string or block comment is
 * scrubbed to end-of-input defensively rather than throwing.
 */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i]!;
    const next = i + 1 < n ? src[i + 1] : "";

    // Line comment: // … \n  (also covers /// doc comments). The terminating
    // newline is left for the outer loop to emit verbatim.
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    // Block comment: /* … */
    if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("  "); // closing */
        i += 2;
      }
      continue;
    }

    // String literals: "…" and '…'
    if (c === '"' || c === "'") {
      const quote = c;
      out.push(" ");
      i++;
      while (i < n && src[i] !== quote) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push(" "); // closing quote
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join("");
}

/**
 * Parse Leo import statements and cross-program calls from .leo source files.
 *
 * Matches:
 * - `import <name>.aleo;`         — explicit import declarations
 * - `<name>.aleo::function()`     — cross-program calls (Leo v4 syntax)
 * - `<name>.aleo/function()`      — cross-program calls (Leo v3.5 syntax)
 *
 * Comments and string literals are stripped before matching, so a `.aleo`
 * token that only appears in a comment or string is never treated as a
 * dependency.
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
    const content = stripCommentsAndStrings(fs.readFileSync(absPath, "utf-8"));

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
