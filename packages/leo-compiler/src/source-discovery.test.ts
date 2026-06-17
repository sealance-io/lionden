import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverUnits,
  extractProgramId,
  ProgramFolderNameMismatchError,
} from "./source-discovery.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("extractProgramId", () => {
  it("extracts program ID from main.leo", () => {
    const file = path.join(tmpDir, "main.leo");
    fs.writeFileSync(file, `program hello.aleo {\n  fn main() {}\n}\n`);
    expect(extractProgramId(file)).toBe("hello.aleo");
  });

  it("extracts only the program ID from a multi-interface declaration", () => {
    const file = path.join(tmpDir, "main.leo");
    fs.writeFileSync(
      file,
      `program hello.aleo : Readable + admin.Owned + interfaces/reader.aleo::Readable {\n  fn main() {}\n}\n`,
    );
    expect(extractProgramId(file)).toBe("hello.aleo");
  });

  it("leaves malformed interface clauses to Leo after discovering the program ID", () => {
    const file = path.join(tmpDir, "main.leo");
    fs.writeFileSync(file, `program hello.aleo : + Readable {\n  fn main() {}\n}\n`);
    expect(extractProgramId(file)).toBe("hello.aleo");
  });

  it("returns null if no program declaration found", () => {
    const file = path.join(tmpDir, "main.leo");
    fs.writeFileSync(file, "fn helper() -> u32 { return 1u32; }\n");
    expect(extractProgramId(file)).toBeNull();
  });

  it("ignores program declarations in line comments", () => {
    const file = path.join(tmpDir, "main.leo");
    fs.writeFileSync(file, "// program fake.aleo {\n");
    expect(extractProgramId(file)).toBeNull();
  });

  it("ignores program declarations in block comments", () => {
    const file = path.join(tmpDir, "main.leo");
    fs.writeFileSync(file, "/* program fake.aleo { */\n");
    expect(extractProgramId(file)).toBeNull();
  });

  it("ignores program declarations in string literals", () => {
    const file = path.join(tmpDir, "main.leo");
    fs.writeFileSync(file, 'const message: field = "program fake.aleo {";\n');
    expect(extractProgramId(file)).toBeNull();
  });

  it("extracts real program declarations after comment and string noise", () => {
    const file = path.join(tmpDir, "main.leo");
    fs.writeFileSync(
      file,
      '"program fake.aleo {"\n// program also_fake.aleo {\nprogram real.aleo {\n}\n',
    );
    expect(extractProgramId(file)).toBe("real.aleo");
  });
});

describe("discoverUnits", () => {
  it("discovers a single program", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(tmpDir);
    expect(units).toHaveLength(1);
    expect(units[0]!.kind).toBe("program");
    if (units[0]!.kind === "program") {
      expect(units[0]!.programId).toBe("hello.aleo");
      expect(units[0]!.allSources).toEqual(["main.leo"]);
    }
  });

  it("throws when a program folder name does not match the declared program name", () => {
    writeFile("foo/main.leo", "program bar.aleo {\n  fn main() {}\n}\n");

    expect(() => discoverUnits(tmpDir)).toThrow(ProgramFolderNameMismatchError);
    expect(() => discoverUnits(tmpDir)).toThrow(
      /folder "foo" declares program "bar\.aleo".*folder names must match.*Rename the folder to "bar".*change the "program \.\.\.".*program foo\.aleo/s,
    );
  });

  it("throws when main.leo has no valid program declaration", () => {
    writeFile("broken/main.leo", "fn helper() -> u32 { return 1u32; }\n");

    const mainLeo = path.join(tmpDir, "broken", "main.leo");
    expect(() => discoverUnits(tmpDir)).toThrow(mainLeo);
  });

  it("discovers a library", () => {
    writeFile("math_utils/lib.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");

    const units = discoverUnits(tmpDir);
    expect(units).toHaveLength(1);
    expect(units[0]!.kind).toBe("library");
    if (units[0]!.kind === "library") {
      expect(units[0]!.name).toBe("math_utils");
    }
  });

  it("discovers nested .leo files", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");
    writeFile("hello/math/helpers.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");

    const units = discoverUnits(tmpDir);
    expect(units).toHaveLength(1);
    const sources = units[0]!.allSources.sort();
    expect(sources).toEqual(["main.leo", "math/helpers.leo"]);
  });

  it("discovers multiple units", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");
    writeFile("token/main.leo", "program token.aleo {\n  fn mint() {}\n}\n");
    writeFile("utils/lib.leo", "fn helper() -> u32 { return 1u32; }\n");

    const units = discoverUnits(tmpDir);
    expect(units).toHaveLength(3);
  });

  it("returns empty for non-existent directory", () => {
    expect(discoverUnits("/nonexistent")).toEqual([]);
  });

  it("ignores directories without main.leo or lib.leo", () => {
    writeFile("random/something.leo", "fn foo() {}\n");

    const units = discoverUnits(tmpDir);
    expect(units).toHaveLength(0);
  });

  it("discovers programs at arbitrary depth (recursive)", () => {
    writeFile("domain/finance/token/main.leo", "program token.aleo {\n  fn mint() {}\n}\n");
    writeFile("domain/utils/math/lib.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");

    const units = discoverUnits(tmpDir);
    expect(units).toHaveLength(2);

    const program = units.find((u) => u.kind === "program");
    const library = units.find((u) => u.kind === "library");
    expect(program).toBeDefined();
    expect(library).toBeDefined();
    if (program?.kind === "program") {
      expect(program.programId).toBe("token.aleo");
    }
    if (library?.kind === "library") {
      expect(library.name).toBe("math");
    }
  });

  it("does not recurse into discovered roots for further roots", () => {
    // If hello/main.leo exists, don't look for roots inside hello/
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");
    // This nested main.leo is a source file of hello, not a separate root
    writeFile("hello/sub/main.leo", "program nested.aleo {\n  fn x() {}\n}\n");

    const units = discoverUnits(tmpDir);
    // Should find only the hello root, which includes sub/main.leo as a source
    expect(units).toHaveLength(1);
    expect(units[0]!.allSources.sort()).toEqual(["main.leo", "sub/main.leo"]);
  });
});
