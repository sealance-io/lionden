import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBindings, generateBaseContract } from "./typescript-generator.js";
import { parseAbi } from "../abi-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../__fixtures__/abi");

function loadAbi(filename: string) {
  const json = readFileSync(resolve(FIXTURES_DIR, filename), "utf-8");
  return parseAbi(json);
}

function expectGeneratedToTypecheck(programName: string, output: string): void {
  const files: Record<string, string> = {
    "/virtual/package.json": '{ "type": "module" }',
    "/virtual/BaseContract.ts": generateBaseContract(),
    [`/virtual/${programName}.ts`]: output,
    "/virtual/core.d.ts": "export interface LionDenRuntimeEnvironment { network: unknown }",
  };

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
    lib: ["lib.es2024.d.ts"],
  };

  const host = ts.createCompilerHost(options);
  const origRead = host.readFile.bind(host);
  const origExists = host.fileExists.bind(host);

  host.readFile = (fileName) => files[fileName] ?? origRead(fileName);
  host.fileExists = (fileName) => Object.hasOwn(files, fileName) || origExists(fileName);
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      if (moduleName === "@lionden/core") {
        return {
          resolvedFileName: "/virtual/core.d.ts",
          extension: ts.Extension.Dts,
          isExternalLibraryImport: true,
        };
      }
      if (moduleName === "./BaseContract.js") {
        return {
          resolvedFileName: "/virtual/BaseContract.ts",
          extension: ts.Extension.Ts,
        };
      }
      return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
    });

  const program = ts.createProgram(Object.keys(files), options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const message = diagnostics.length === 0
    ? ""
    : ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => "/virtual",
        getCanonicalFileName: (fileName) => fileName,
        getNewLine: () => "\n",
      });

  expect(message).toBe("");
}

const FIXTURE_PAIRS: [string, string][] = [
  // Real ABIs
  ["hello.abi.json", "hello.ts"],
  ["token.abi.json", "token.ts"],
  ["rewards.abi.json", "rewards.ts"],
  ["treasury.abi.json", "treasury.ts"],
  // Edge-case ABIs
  ["edge-nested-structs.abi.json", "nested-structs.ts"],
  ["edge-optional-fields.abi.json", "optional-fields.ts"],
  ["edge-arrays-nested.abi.json", "arrays-nested.ts"],
  ["edge-module-scoped.abi.json", "module-scoped.ts"],
  ["edge-external-refs.abi.json", "external-refs.ts"],
  ["edge-dynamic-record.abi.json", "dynamic-record.ts"],
  ["edge-storage-variables.abi.json", "storage-variables.ts"],
  ["edge-mixed-async.abi.json", "mixed-async.ts"],
  ["edge-dex.abi.json", "dex.ts"],
];

describe("codegen goldens", () => {
  for (const [fixtureFile, goldenFile] of FIXTURE_PAIRS) {
    it(`generates expected output for ${fixtureFile}`, async () => {
      const abi = loadAbi(fixtureFile);
      const output = generateBindings(abi);
      await expect(output).toMatchFileSnapshot(
        resolve(__dirname, "__goldens__", goldenFile),
      );
    });
  }

  it("generates expected BaseContract output", async () => {
    const output = generateBaseContract();
    await expect(output).toMatchFileSnapshot(
      resolve(__dirname, "__goldens__", "base-contract.ts"),
    );
  });
});

describe("codegen golden TypeScript validity", () => {
  for (const [fixtureFile, goldenFile] of FIXTURE_PAIRS) {
    it(`${goldenFile} typechecks`, () => {
      const abi = loadAbi(fixtureFile);
      const output = generateBindings(abi);
      expectGeneratedToTypecheck(goldenFile.replace(".ts", ""), output);
    });
  }
});
