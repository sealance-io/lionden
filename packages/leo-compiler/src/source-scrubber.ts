/**
 * Replace comment and string-literal spans in Leo source with whitespace so
 * regex-based scanners only ever see real code. A `<name>.aleo` token that
 * appears in a doc comment (`// see token.aleo::transfer`) or an annotation
 * string (`@checksum(mapping="x.aleo::m")`) would otherwise be detected as a
 * phantom dependency.
 *
 * Single forward scan over the source. Inside a line comment, a block comment,
 * or a string (`"..."` / `'...'`) every character except newlines is replaced by
 * a space, so offsets and line numbers are preserved while no `.aleo` token can
 * survive. Leo string/identifier literals carry no escape sequences and no
 * newlines in practice (only addresses, identifiers, and mapping refs), so no
 * escape handling is needed. An unterminated string or block comment is
 * scrubbed to end-of-input defensively rather than throwing.
 */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i]!;
    const next = i + 1 < n ? src[i + 1] : "";

    // Line comment: // ... \n  (also covers /// doc comments). The terminating
    // newline is left for the outer loop to emit verbatim.
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    // Block comment: /* ... */
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

    // String literals: "..." and '...'
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
