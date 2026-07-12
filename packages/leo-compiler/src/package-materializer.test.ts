import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDependencies } from "./dependency-resolver.js";
import { materializePackage } from "./package-materializer.js";
import { discoverUnits } from "./source-discovery.js";
import { unitId } from "./types.js";

let tmpDir: string;
let programsDir: string;
let artifactsDir: string;

function mockConfig(): LionDenResolvedConfig {
  return {
    leoVersion: "4.0.0",
    skipLeoVersionCheck: false,
    leoBinary: "leo",
    paths: {
      root: tmpDir,
      programs: programsDir,
      artifacts: artifactsDir,
      typechain: path.join(tmpDir, "typechain"),
      cache: path.join(tmpDir, ".cache"),
      deployments: path.join(tmpDir, "deployments"),
    },
    networks: {
      devnode: {
        type: "devnode",
        socketAddr: "127.0.0.1:3030",
        autoBlock: true,
        verbosity: 0,
        accounts: [],
        network: "testnet",
        ephemeral: true,
      },
    },
    defaultNetwork: "devnode",
    compiler: {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    },
    codegen: { enabled: true, outDir: "typechain", dynamicRecords: {} },
    testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
    deploy: {
      defaultPriorityFee: 0,
      privateFee: false,
      confirmTransactions: true,
      confirmationTimeout: 60_000,
      deploymentsDir: "deployments",
      skipDeployed: true,
      autoExport: false,
    },
    sdk: { keyCache: { storage: "memory" } },
    execution: { imports: {} },
    namedAccounts: {},
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
    expect(programJson.leo).toBeUndefined();
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
    writeFile(
      "token/main.leo",
      `
import utils.aleo;
import credits.aleo;
program token.aleo { fn mint() { utils.aleo::add(); } }
`,
    );

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();

    const tokenUnit = units.find((u) => unitId(u) === "token.aleo")!;
    const pkgDir = materializePackage(tokenUnit, config, graph);

    const programJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "program.json"), "utf-8"));
    expect(programJson.dependencies).toHaveLength(2);

    const localDep = programJson.dependencies.find(
      (d: { name: string }) => d.name === "utils.aleo",
    );
    expect(localDep.location).toBe("local");

    const networkDep = programJson.dependencies.find(
      (d: { name: string }) => d.name === "credits.aleo",
    );
    expect(networkDep.location).toBe("network");
  });

  it("renames only the primary program declaration and manifest program", () => {
    writeFile("utils/main.leo", "program utils.aleo {\n  fn add() {}\n}\n");
    writeFile(
      "hello/main.leo",
      `
import utils.aleo;
program hello.aleo {
  fn main() {
    utils.aleo::add();
  }
}
`,
    );

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const helloUnit = units.find((u) => unitId(u) === "hello.aleo")!;
    const pkgDir = materializePackage(helloUnit, config, graph, undefined, {
      sourceProgramId: "hello.aleo",
      targetProgramId: "renamed_hello.aleo",
    });

    expect(path.basename(pkgDir)).toBe("renamed_hello.aleo");
    const main = fs.readFileSync(path.join(pkgDir, "src", "main.leo"), "utf-8");
    expect(main).toContain("program renamed_hello.aleo");
    expect(main).toContain("import utils.aleo;");
    expect(main).toContain("utils.aleo::add()");

    const programJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "program.json"), "utf-8"));
    expect(programJson.program).toBe("renamed_hello.aleo");
    expect(programJson.dependencies.map((dep: { name: string }) => dep.name)).toContain(
      "utils.aleo",
    );
  });

  it("renames the real program declaration without changing an earlier comment", () => {
    writeFile(
      "hello/main.leo",
      `// example: program hello.aleo should stay in this comment
program hello.aleo {
  fn main() {}
}
`,
    );

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph, undefined, {
      sourceProgramId: "hello.aleo",
      targetProgramId: "renamed_hello.aleo",
    });

    const main = fs.readFileSync(path.join(pkgDir, "src", "main.leo"), "utf-8");
    expect(main).toContain("// example: program hello.aleo should stay in this comment");
    expect(main).toContain("program renamed_hello.aleo {");
  });

  it("renames the real program declaration without changing an earlier string literal", () => {
    writeFile(
      "hello/main.leo",
      `const MESSAGE: string = "program hello.aleo should stay in this string";
program hello.aleo {
  fn main() {}
}
`,
    );

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph, undefined, {
      sourceProgramId: "hello.aleo",
      targetProgramId: "renamed_hello.aleo",
    });

    const main = fs.readFileSync(path.join(pkgDir, "src", "main.leo"), "utf-8");
    expect(main).toContain('"program hello.aleo should stay in this string"');
    expect(main).toContain("program renamed_hello.aleo {");
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
    expect(env).toContain(
      "PRIVATE_KEY=APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
    );
    expect(env).toContain("DEVNET=true");
  });

  it("emits the override network's .env (http branch) instead of the default", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    (config.networks as Record<string, unknown>)["alt"] = {
      type: "http",
      endpoint: "https://api.explorer.provable.com/v1",
      network: "mainnet",
      privateKey: "APrivateKey1zkpAltKeyAltKeyAltKeyAltKeyAltKeyAltKeyAltKeyAlt",
      ephemeral: false,
    };

    const pkgDir = materializePackage(units[0]!, config, graph, "alt");

    const env = fs.readFileSync(path.join(pkgDir, ".env"), "utf-8");
    expect(env).toContain("NETWORK=mainnet");
    expect(env).toContain("ENDPOINT=https://api.explorer.provable.com/v1");
    expect(env).toContain(
      "PRIVATE_KEY=APrivateKey1zkpAltKeyAltKeyAltKeyAltKeyAltKeyAltKeyAltKeyAlt",
    );
    // HTTP network → no DEVNET marker
    expect(env).not.toContain("DEVNET=true");
  });

  it("emits the override network's .env (devnode branch) when default is http", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    (config.networks as Record<string, unknown>)["alt_devnode"] = {
      type: "devnode",
      socketAddr: "127.0.0.1:9999",
      autoBlock: true,
      verbosity: 0,
      accounts: [],
      network: "testnet",
      ephemeral: true,
    };

    const pkgDir = materializePackage(units[0]!, config, graph, "alt_devnode");

    const env = fs.readFileSync(path.join(pkgDir, ".env"), "utf-8");
    expect(env).toContain("NETWORK=testnet");
    expect(env).toContain("ENDPOINT=http://127.0.0.1:9999");
    expect(env).toContain("DEVNET=true");
  });

  it("falls back to defaultNetwork's .env when no override is given", () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    (config.networks as Record<string, unknown>)["alt"] = {
      type: "http",
      endpoint: "https://api.explorer.provable.com/v1",
      network: "mainnet",
      ephemeral: false,
    };

    // No network arg → defaultNetwork (devnode/testnet), as before.
    const pkgDir = materializePackage(units[0]!, config, graph);

    const env = fs.readFileSync(path.join(pkgDir, ".env"), "utf-8");
    expect(env).toContain("NETWORK=testnet");
    expect(env).toContain("ENDPOINT=http://127.0.0.1:3030");
    expect(env).toContain("DEVNET=true");
  });

  it("materializes library dependency with canonical path", () => {
    writeFile("math/lib.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");
    writeFile(
      "hello/main.leo",
      `
import math.aleo;
program hello.aleo { fn main() { math.aleo::add(1u32, 2u32); } }
`,
    );

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
    const programJson = JSON.parse(
      fs.readFileSync(path.join(helloPkgDir, "program.json"), "utf-8"),
    );

    const mathDep = programJson.dependencies?.find((d: { name: string }) => d.name === "math.aleo");
    expect(mathDep).toBeDefined();
    expect(mathDep.location).toBe("local");
    expect(mathDep.path).toContain(path.join(".build", "math"));
  });
});
