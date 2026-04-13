import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverUnits } from "./source-discovery.js";
import { resolveDependencies } from "./dependency-resolver.js";
import { materializePackage } from "./package-materializer.js";
import { unitId } from "./types.js";
import type { LionDenResolvedConfig } from "@lionden/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-materialize-golden-"));
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

/**
 * Normalize absolute paths in materialized output so goldens are portable.
 * Replaces everything before `.build/` (or `\.build\` on Windows) with a
 * `<ROOT>/artifacts/.build` placeholder, and normalizes any remaining
 * backslash separators to forward slashes.
 */
function normalizePaths(content: string): string {
  return content
    .replace(/("path": ").*?[/\\]\.build[/\\]/g, '$1<ROOT>/artifacts/.build/')
    .replace(/\\\\/g, "/");
}

describe("materializer goldens", () => {
  it("produces expected program.json for a simple program", async () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph);

    const programJson = fs.readFileSync(path.join(pkgDir, "program.json"), "utf-8");
    await expect(programJson).toMatchFileSnapshot(
      resolve(__dirname, "__goldens__/materializer", "hello-program.json"),
    );
  });

  it("produces expected .env for devnode config", async () => {
    writeFile("hello/main.leo", "program hello.aleo {\n  fn main() {}\n}\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph);

    const env = fs.readFileSync(path.join(pkgDir, ".env"), "utf-8");
    await expect(env).toMatchFileSnapshot(
      resolve(__dirname, "__goldens__/materializer", "hello-env.txt"),
    );
  });

  it("produces expected program.json with dependencies", async () => {
    writeFile("utils/main.leo", "program utils.aleo {\n  fn add() {}\n}\n");
    writeFile("token/main.leo",
      "import utils.aleo;\nimport credits.aleo;\nprogram token.aleo { fn mint() { utils.aleo::add(); } }\n",
    );

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();

    const tokenUnit = units.find((u) => unitId(u) === "token.aleo")!;
    const pkgDir = materializePackage(tokenUnit, config, graph);

    const programJson = fs.readFileSync(path.join(pkgDir, "program.json"), "utf-8");
    const normalized = normalizePaths(programJson);
    await expect(normalized).toMatchFileSnapshot(
      resolve(__dirname, "__goldens__/materializer", "token-with-deps-program.json"),
    );
  });

  it("produces expected program.json for library manifest", async () => {
    writeFile("math/lib.leo", "fn add(a: u32, b: u32) -> u32 { return a + b; }\n");

    const units = discoverUnits(programsDir);
    const graph = resolveDependencies(units);
    const config = mockConfig();
    const pkgDir = materializePackage(units[0]!, config, graph);

    const programJson = fs.readFileSync(path.join(pkgDir, "program.json"), "utf-8");
    await expect(programJson).toMatchFileSnapshot(
      resolve(__dirname, "__goldens__/materializer", "library-program.json"),
    );
  });
});
