import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverUnits } from "./source-discovery.js";
import { resolveDependencies } from "./dependency-resolver.js";
import { materializePackage } from "./package-materializer.js";
import { unitId } from "./types.js";
import type { LionDenResolvedConfig } from "@lionden/config";

let tmpDir: string;
let programsDir: string;
let artifactsDir: string;

function mockConfig(): LionDenResolvedConfig {
  return {
    leoVersion: "4.0.0",
    leoBinary: "leo",
    paths: {
      root: tmpDir,
      programs: programsDir,
      artifacts: artifactsDir,
      typechain: path.join(tmpDir, "typechain"),
      cache: path.join(tmpDir, ".cache"),
    },
    networks: {
      devnode: {
        type: "devnode",
        socketAddr: "127.0.0.1:3030",
        autoBlock: true,
        verbosity: 0,
        accounts: [],
        network: "testnet",
      },
    },
    defaultNetwork: "devnode",
    compiler: {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    },
    codegen: { enabled: true, outDir: "typechain" },
    testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
    deploy: { defaultPriorityFee: 0, privateFee: false, confirmTransactions: true, confirmationTimeout: 60_000 },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-materialize-"));
  programsDir = path.join(tmpDir, "programs");
  artifactsDir = path.join(tmpDir, "artifacts");
  fs.mkdirSync(programsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const abs = path.join(programsDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("materializePackage", () => {
  it("creates a Leo CLI package structure for a program", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph);

    // Verify package structure
    expect(fs.existsSync(path.join(pkgDir, "program.json"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, ".env"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "src", "main.leo"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "imports"))).toBe(true);

    // Verify program.json content
    const programJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "program.json"), "utf-8"));
    expect(programJson.program).toBe("hello.aleo");
  });

  it("preserves nested directory structure in src/", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");
    writeFile("hello/math/helpers.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph);

    expect(fs.existsSync(path.join(pkgDir, "src", "main.leo"))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, "src", "math", "helpers.leo"))).toBe(true);
  });

  it("generates program.json with dependencies", () => {
    writeFile("utils/main.leo", "program utils.aleo {\n  fn add() {}\n}\n");
    writeFile("token/main.leo", `
import utils.aleo;
import credits.aleo;
program token.aleo { fn mint() { utils.aleo::add(); } }
`);

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();

    const tokenUnit = units.find((u) => unitId(u) === "token.aleo")!;
    const pkgDir = materializePackage(tokenUnit, config, graph);

    const programJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "program.json"), "utf-8"));
    expect(programJson.dependencies).toHaveLength(2);

    const localDep = programJson.dependencies.find((d: { name: string }) => d.name === "utils.aleo");
    expect(localDep.location).toBe("local");

    const networkDep = programJson.dependencies.find((d: { name: string }) => d.name === "credits.aleo");
    expect(networkDep.location).toBe("network");
  });

  it("uses .aleo suffix for library program name in manifest", () => {
    writeFile("math/lib.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph);

    const programJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "program.json"), "utf-8"));
    expect(programJson.program).toBe("math.aleo");
  });

  it("generates .env with devnode defaults", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph);

    const env = fs.readFileSync(path.join(pkgDir, ".env"), "utf-8");
    expect(env).toContain("NETWORK=testnet");
    expect(env).toContain("ENDPOINT=http://127.0.0.1:3030");
    expect(env).toContain("PRIVATE_KEY=APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH");
    expect(env).toContain("DEVNET=true");
  });

  it("materializes library dependency with canonical path", () => {
    writeFile("math/lib.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");
    writeFile("hello/main.leo", `
import math.aleo;
program hello.aleo { fn main() { math.aleo::add(1u32, 2u32); } }
`);

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();

    // Materialize the library — directory uses canonical name (no .aleo suffix)
    const mathUnit = units.find((u) => u.kind === "library")!;
    const mathPkgDir = materializePackage(mathUnit, config, graph);
    expect(mathPkgDir).toContain(path.join(".build", "math"));
    expect(mathPkgDir).not.toContain("math.aleo");

    // Library manifest must declare "math.aleo" so Leo CLI can match imports
    const mathJson = JSON.parse(fs.readFileSync(path.join(mathPkgDir, "program.json"), "utf-8"));
    expect(mathJson.program).toBe("math.aleo");

    // Materialize the program — its deps should use "math.aleo" name
    // (matching Leo import syntax) but the path still uses the canonical dir
    const helloUnit = units.find((u) => u.kind === "program")!;
    const helloPkgDir = materializePackage(helloUnit, config, graph);
    const programJson = JSON.parse(fs.readFileSync(path.join(helloPkgDir, "program.json"), "utf-8"));

    const mathDep = programJson.dependencies?.find((d: { name: string }) => d.name === "math.aleo");
    expect(mathDep).toBeDefined();
    expect(mathDep.location).toBe("local");
    expect(mathDep.path).toContain(path.join(".build", "math"));
  });
});
