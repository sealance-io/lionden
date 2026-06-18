import { describe, expect, it } from "vitest";
import { stripCommentsAndStrings } from "./source-scrubber.js";

/**
 * Replace every non-newline char with "." so two strings can be compared
 * purely on length and newline positions. The scrubber must preserve both so
 * downstream regex matches keep correct offsets and line numbers.
 */
function newlineSkeleton(s: string): string {
  return s.replace(/[^\n]/g, ".");
}

describe("stripCommentsAndStrings", () => {
  it("returns code with no comments or strings unchanged", () => {
    const src = "program hello.aleo { fn main() {} }";
    expect(stripCommentsAndStrings(src)).toBe(src);
  });

  it("scrubs a line comment to spaces (incl. /// doc comments), leaving code intact", () => {
    const src = "let a = 1u32; /// token.aleo::mint";
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain("token.aleo");
    expect(out).toMatch(/^let a = 1u32; +$/);
  });

  it("scrubs a block comment to spaces, preserving surrounding code", () => {
    const src = "a /* token.aleo::m */ b";
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain("token.aleo");
    // Only spaces survive between the two code tokens.
    expect(out).toMatch(/^a +b$/);
  });

  it("scrubs a string literal to spaces, preserving surrounding code", () => {
    const src = 'x = "token.aleo::m" ;';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain("token.aleo");
    expect(out).toMatch(/^x = +;$/);
  });

  it("preserves length and newline positions when scrubbing a multi-line block comment", () => {
    const src = [
      "program hello.aleo {",
      "  /* multi",
      "     line token.aleo",
      "     comment */",
      "  fn main() {}",
      "}",
    ].join("\n");
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(newlineSkeleton(out)).toBe(newlineSkeleton(src));
    expect(out).toContain("program hello.aleo {");
    expect(out).toContain("fn main() {}");
    expect(out).not.toContain("token.aleo");
  });

  it("scrubs an unterminated block comment to end-of-input without throwing", () => {
    const src = "code /* token.aleo never closed";
    const out = stripCommentsAndStrings(src);
    expect(out).toBe("code " + " ".repeat(src.length - "code ".length));
    expect(out).not.toContain("token.aleo");
  });

  it("scrubs an unterminated string literal to end-of-input without throwing", () => {
    const src = 'code "token.aleo never closed';
    const out = stripCommentsAndStrings(src);
    expect(out).toBe("code " + " ".repeat(src.length - "code ".length));
    expect(out).not.toContain("token.aleo");
  });

  it("treats // inside a string as string content, not a comment", () => {
    // If `//` were treated as a comment, the closing quote and the code after
    // it would be swallowed to end-of-line. The string must win.
    const src = 'let u = "http://x.aleo"; program real.aleo {}';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain("x.aleo"); // string content scrubbed
    expect(out).toContain("program real.aleo {}"); // code after the string survives
  });

  it("treats a quote inside a line comment as comment content, not a string opener", () => {
    // If the `"` opened a string, scrubbing would run past the newline and
    // swallow the program declaration on the next line.
    const src = '// a stray " quote\nprogram real.aleo {}';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(newlineSkeleton(out)).toBe(newlineSkeleton(src));
    expect(out).toContain("program real.aleo {}");
  });

  it("closes a nested block comment on the first */ (documents the known limitation)", () => {
    // The scrubber does not track block-comment nesting; it closes on the first
    // `*/` and exposes the rest as code. This matches Leo's own lexer, which
    // likewise rejects nested block comments, so no valid Leo source is
    // affected (see source-discovery probe 9).
    const src = "/* /* */ program x.aleo {} */";
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).toContain("program x.aleo"); // exposed: the first */ closed the comment
  });
});
