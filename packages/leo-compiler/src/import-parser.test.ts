import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseImports } from "./import-parser.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-imports-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("parseImports", () => {
  it("parses import declarations", () => {
    writeFile(
      "main.leo",
      `
import credits.aleo;
import token.aleo;

program hello.aleo {
  fn main() {}
}
`,
    );

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports.sort()).toEqual(["credits.aleo", "token.aleo"]);
  });

  it("parses cross-program calls (Leo v4 :: syntax)", () => {
    writeFile(
      "main.leo",
      `
program hello.aleo {
  fn bar(a: u64) -> u64 {
    return foo.aleo::safe_add(a, 1u64);
  }
}
`,
    );

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports).toEqual(["foo.aleo"]);
  });

  it("deduplicates imports from declarations and cross-calls", () => {
    writeFile(
      "main.leo",
      `
import token.aleo;

program hello.aleo {
  fn transfer() {
    token.aleo::mint(100u64);
  }
}
`,
    );

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports).toEqual(["token.aleo"]);
  });

  it("scans all files in the list", () => {
    writeFile(
      "main.leo",
      `
import credits.aleo;
program hello.aleo { fn main() {} }
`,
    );
    writeFile(
      "internal/ops.leo",
      `
import token.aleo;
fn helper() { token.aleo::mint(1u64); }
`,
    );

    const imports = parseImports(tmpDir, ["main.leo", "internal/ops.leo"]);
    expect(imports.sort()).toEqual(["credits.aleo", "token.aleo"]);
  });

  it("parses cross-program calls (Leo v3.5 / syntax)", () => {
    writeFile(
      "main.leo",
      `
import math_helpers.aleo;

program calculator.aleo {
  transition compute(a: u64, b: u64) -> u64 {
    let clamped: u64 = math_helpers.aleo/clamp(a, 0u64, 1000u64);
    return clamped;
  }
}
`,
    );

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports).toEqual(["math_helpers.aleo"]);
  });

  it("deduplicates v3.5 slash-calls with import declarations", () => {
    writeFile(
      "main.leo",
      `
import token.aleo;

program hello.aleo {
  transition transfer() {
    token.aleo/mint(100u64);
  }
}
`,
    );

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports).toEqual(["token.aleo"]);
  });

  it("discovers both v4 :: calls and v3.5 / calls in same file", () => {
    writeFile(
      "main.leo",
      `
import v4dep.aleo;
import v35dep.aleo;

program mixed.aleo {
  fn use_both() {
    v4dep.aleo::foo();
    v35dep.aleo/bar();
  }
}
`,
    );

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports.sort()).toEqual(["v35dep.aleo", "v4dep.aleo"]);
  });

  it("returns empty for no imports", () => {
    writeFile("main.leo", "program hello.aleo {\n  fn main() {}\n}\n");
    expect(parseImports(tmpDir, ["main.leo"])).toEqual([]);
  });

  it("ignores a .aleo mention in a line comment", () => {
    writeFile(
      "main.leo",
      `
program hello.aleo {
  // see token.aleo::helper
  fn main() {}
}
`,
    );
    expect(parseImports(tmpDir, ["main.leo"])).toEqual([]);
  });

  it("ignores a .aleo mention in a block comment", () => {
    writeFile(
      "main.leo",
      `
/* uses other.aleo::x for reference */
program hello.aleo {
  fn main() {}
}
`,
    );
    expect(parseImports(tmpDir, ["main.leo"])).toEqual([]);
  });

  it("ignores a slash-form .aleo mention inside a URL comment", () => {
    writeFile(
      "main.leo",
      `
program hello.aleo {
  // docs at https://foo.aleo/bar
  fn main() {}
}
`,
    );
    expect(parseImports(tmpDir, ["main.leo"])).toEqual([]);
  });

  it("detects real imports while ignoring a commented mention", () => {
    writeFile(
      "main.leo",
      `
import x.aleo;

program hello.aleo {
  // unrelated: z.aleo::w is just a note
  fn use() { y.aleo::call(); }
}
`,
    );
    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports.sort()).toEqual(["x.aleo", "y.aleo"]);
  });

  it("ignores a @checksum mapping string when there is no import", () => {
    writeFile(
      "main.leo",
      `
@checksum(mapping="basic_voting.aleo::approved_checksum", key="true")
program vote_example.aleo {
  fn main() {}
}
`,
    );
    expect(parseImports(tmpDir, ["main.leo"])).toEqual([]);
  });

  it("still detects the dep when @checksum is paired with a real import", () => {
    writeFile(
      "main.leo",
      `
import basic_voting.aleo;

@checksum(mapping="basic_voting.aleo::approved_checksum", key="true")
program vote_example.aleo {
  fn main() {}
}
`,
    );
    expect(parseImports(tmpDir, ["main.leo"])).toEqual(["basic_voting.aleo"]);
  });

  it("handles // inside a string and quotes inside a comment without false detection", () => {
    writeFile(
      "main.leo",
      `
@admin(address="aleo1abc//notacomment.aleo::x")
program hello.aleo {
  // the "real.aleo::x" call lives only here
  fn main() {}
}
`,
    );
    expect(parseImports(tmpDir, ["main.leo"])).toEqual([]);
  });

  it("preserves real imports adjacent to comment and string noise", () => {
    writeFile(
      "main.leo",
      `
import dep.aleo; // dep.aleo also mentioned: ignored.aleo::x
@checksum(mapping="phantom.aleo::m", key="true")
program hello.aleo {
  fn use() {
    /* commented.aleo::y */
    dep.aleo::run();
  }
}
`,
    );
    expect(parseImports(tmpDir, ["main.leo"])).toEqual(["dep.aleo"]);
  });
});
