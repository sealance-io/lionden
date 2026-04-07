import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
    writeFile("main.leo", `
import credits.aleo;
import token.aleo;

program hello.aleo {
  fn main() {}
}
`);

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports.sort()).toEqual(["credits.aleo", "token.aleo"]);
  });

  it("parses cross-program calls (Leo v4 :: syntax)", () => {
    writeFile("main.leo", `
program hello.aleo {
  fn bar(a: u64) -> u64 {
    return foo.aleo::safe_add(a, 1u64);
  }
}
`);

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports).toEqual(["foo.aleo"]);
  });

  it("deduplicates imports from declarations and cross-calls", () => {
    writeFile("main.leo", `
import token.aleo;

program hello.aleo {
  fn transfer() {
    token.aleo::mint(100u64);
  }
}
`);

    const imports = parseImports(tmpDir, ["main.leo"]);
    expect(imports).toEqual(["token.aleo"]);
  });

  it("scans all files in the list", () => {
    writeFile("main.leo", `
import credits.aleo;
program hello.aleo { fn main() {} }
`);
    writeFile("internal/ops.leo", `
import token.aleo;
fn helper() { token.aleo::mint(1u64); }
`);

    const imports = parseImports(tmpDir, ["main.leo", "internal/ops.leo"]);
    expect(imports.sort()).toEqual(["credits.aleo", "token.aleo"]);
  });

  it("returns empty for no imports", () => {
    writeFile("main.leo", "program hello.aleo {\n  fn main() {}\n}\n");
    expect(parseImports(tmpDir, ["main.leo"])).toEqual([]);
  });
});
