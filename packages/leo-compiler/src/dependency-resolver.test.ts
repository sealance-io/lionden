import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CircularDependencyError, resolveDependencies } from "./dependency-resolver.js";
import { discoverUnits } from "./source-discovery.js";
import { unitId } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-deps-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("resolveDependencies", () => {
  it("resolves independent programs with no imports", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");
    writeFile("world/main.leo", "program world.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(tmpDir);
    const graph = resolveDependencies(units);

    expect(graph.order).toHaveLength(2);
    expect(graph.networkDeps.size).toBe(0);
  });

  it("orders dependencies before dependents", () => {
    writeFile("utils/main.leo", "program utils.aleo {\n  fn add() {}\n}\n");
    writeFile(
      "token/main.leo",
      `
import utils.aleo;
program token.aleo {
  fn mint() { utils.aleo::add(); }
}
`,
    );

    const units = discoverUnits(tmpDir);
    const graph = resolveDependencies(units);

    const ids = graph.order.map(unitId);
    expect(ids.indexOf("utils.aleo")).toBeLessThan(ids.indexOf("token.aleo"));
  });

  it("classifies network dependencies", () => {
    writeFile(
      "hello/main.leo",
      `
import credits.aleo;
program hello.aleo {
  fn pay() { credits.aleo::transfer_public(1u64); }
}
`,
    );

    const units = discoverUnits(tmpDir);
    const graph = resolveDependencies(units);

    expect(graph.networkDeps.has("credits.aleo")).toBe(true);
    expect(graph.order).toHaveLength(1);
  });

  it("detects circular dependencies", () => {
    writeFile(
      "a/main.leo",
      `
import b.aleo;
program a.aleo { fn x() { b.aleo::y(); } }
`,
    );
    writeFile(
      "b/main.leo",
      `
import a.aleo;
program b.aleo { fn y() { a.aleo::x(); } }
`,
    );

    const units = discoverUnits(tmpDir);
    expect(() => resolveDependencies(units)).toThrow(CircularDependencyError);
  });

  it("handles library dependencies", () => {
    writeFile("math/lib.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");
    writeFile(
      "hello/main.leo",
      `
import math.aleo;
program hello.aleo { fn main() { math.aleo::add(1u32, 2u32); } }
`,
    );

    const units = discoverUnits(tmpDir);
    const graph = resolveDependencies(units);

    const ids = graph.order.map(unitId);
    // Library should come before the program that depends on it
    expect(ids.indexOf("math")).toBeLessThan(ids.indexOf("hello.aleo"));
    expect(graph.networkDeps.size).toBe(0);
  });

  it("handles transitive dependencies", () => {
    writeFile("base/main.leo", "program base.aleo { fn x() {} }\n");
    writeFile(
      "mid/main.leo",
      `
import base.aleo;
program mid.aleo { fn y() { base.aleo::x(); } }
`,
    );
    writeFile(
      "top/main.leo",
      `
import mid.aleo;
program top.aleo { fn z() { mid.aleo::y(); } }
`,
    );

    const units = discoverUnits(tmpDir);
    const graph = resolveDependencies(units);

    const ids = graph.order.map(unitId);
    expect(ids.indexOf("base.aleo")).toBeLessThan(ids.indexOf("mid.aleo"));
    expect(ids.indexOf("mid.aleo")).toBeLessThan(ids.indexOf("top.aleo"));
  });

  it("normalizes library imports to canonical unitId in imports map", () => {
    writeFile("math/lib.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");
    writeFile(
      "hello/main.leo",
      `
import math.aleo;
program hello.aleo { fn main() { math.aleo::add(1u32, 2u32); } }
`,
    );

    const units = discoverUnits(tmpDir);
    const graph = resolveDependencies(units);

    // The imports map for hello.aleo should contain "math" (canonical), not "math.aleo"
    const helloImports = graph.imports.get("hello.aleo");
    expect(helloImports).toBeDefined();
    expect(helloImports).toContain("math");
    expect(helloImports).not.toContain("math.aleo");
    // math.aleo should NOT be classified as a network dep
    expect(graph.networkDeps.has("math.aleo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge-case fixtures — multi-program graph scenarios
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__/programs");

describe("resolveDependencies — edge-case fixtures", () => {
  it("resolves diamond dependency correctly", () => {
    const units = discoverUnits(path.resolve(FIXTURES_DIR, "diamond"));
    const graph = resolveDependencies(units);
    const ids = graph.order.map(unitId);

    // D must come before B and C; B and C must come before A
    expect(ids.indexOf("d.aleo")).toBeLessThan(ids.indexOf("b.aleo"));
    expect(ids.indexOf("d.aleo")).toBeLessThan(ids.indexOf("c.aleo"));
    expect(ids.indexOf("b.aleo")).toBeLessThan(ids.indexOf("a.aleo"));
    expect(ids.indexOf("c.aleo")).toBeLessThan(ids.indexOf("a.aleo"));
    expect(ids).toHaveLength(4);
    expect(graph.networkDeps.size).toBe(0);
  });

  it("resolves deep import chain correctly", () => {
    const units = discoverUnits(path.resolve(FIXTURES_DIR, "deep-chain"));
    const graph = resolveDependencies(units);
    const ids = graph.order.map(unitId);

    expect(ids).toEqual(["d.aleo", "c.aleo", "b.aleo", "a.aleo"]);
    expect(graph.networkDeps.size).toBe(0);
  });

  it("resolves program importing library", () => {
    const units = discoverUnits(path.resolve(FIXTURES_DIR, "lib-import"));
    const graph = resolveDependencies(units);
    const ids = graph.order.map(unitId);

    expect(ids.indexOf("math")).toBeLessThan(ids.indexOf("app.aleo"));
    expect(graph.networkDeps.size).toBe(0);

    // The imports map should use the canonical library name
    const appImports = graph.imports.get("app.aleo");
    expect(appImports).toContain("math");
  });

  it("resolves program importing program", () => {
    const units = discoverUnits(path.resolve(FIXTURES_DIR, "program-import"));
    const graph = resolveDependencies(units);
    const ids = graph.order.map(unitId);

    expect(ids.indexOf("utils.aleo")).toBeLessThan(ids.indexOf("app.aleo"));
    expect(graph.networkDeps.size).toBe(0);
  });
});
