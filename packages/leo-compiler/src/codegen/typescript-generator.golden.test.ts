import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseAbi } from "../abi-parser.js";
import { generateBaseContract, generateBindings } from "./typescript-generator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../__fixtures__/abi");

function loadAbi(filename: string) {
  const json = readFileSync(resolve(FIXTURES_DIR, filename), "utf-8");
  return parseAbi(json);
}

const TS_TYPECHECK_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  lib: ["lib.es2024.d.ts"],
};

// Virtual @lionden/network surface — keeps the typecheck harness independent of
// built dist artifacts. Must match the runtime signatures imported by the
// generated BaseContract template.
const VIRTUAL_NETWORK_DTS = [
  'export declare function decryptRecordCiphertext(ciphertext: string, viewKey: string, options?: { readonly network?: "testnet" | "mainnet" }): Promise<string>;',
  'export declare function decryptValueCiphertext(ciphertext: string, viewKey: string, tpk: string, programId: string, transitionName: string, globalIndex: number, options?: { readonly network?: "testnet" | "mainnet" }): Promise<string>;',
  'export declare function deriveViewKey(privateKey: string, options?: { readonly network?: "testnet" | "mainnet" }): Promise<string>;',
  "export declare function programAddressFromProgramId(programId: string): string;",
  "export declare class NetworkRecordDecryptionError extends Error {",
  '  readonly kind: "NetworkRecordDecryptionError";',
  "  readonly ciphertextPrefix: string;",
  "  constructor(message: string, ciphertextPrefix: string, cause?: unknown);",
  "}",
  "export declare class NetworkValueDecryptionError extends Error {",
  '  readonly kind: "NetworkValueDecryptionError";',
  "  readonly ciphertextPrefix: string;",
  "  constructor(message: string, ciphertextPrefix: string, cause?: unknown);",
  "}",
].join("\n");

function virtualBaseFiles(): Record<string, string> {
  return {
    "/virtual/package.json": '{ "type": "module" }',
    "/virtual/BaseContract.ts": generateBaseContract(),
    "/virtual/core.d.ts": "export interface LionDenRuntimeEnvironment { network: unknown }",
    "/virtual/network.d.ts": VIRTUAL_NETWORK_DTS,
  };
}

function runTypecheck(files: Record<string, string>): void {
  const options = TS_TYPECHECK_OPTIONS;
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
      if (moduleName === "@lionden/network") {
        return {
          resolvedFileName: "/virtual/network.d.ts",
          extension: ts.Extension.Dts,
          isExternalLibraryImport: true,
        };
      }
      // Resolve any sibling generated module ("./Foo.js" → "/virtual/Foo.ts")
      // that the harness provided — covers BaseContract and cross-program refs.
      if (moduleName.startsWith("./") && moduleName.endsWith(".js")) {
        const resolved = `/virtual/${moduleName.slice(2, -3)}.ts`;
        if (Object.hasOwn(files, resolved)) {
          return { resolvedFileName: resolved, extension: ts.Extension.Ts };
        }
      }
      return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
    });

  const program = ts.createProgram(Object.keys(files), options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const message =
    diagnostics.length === 0
      ? ""
      : ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCurrentDirectory: () => "/virtual",
          getCanonicalFileName: (fileName) => fileName,
          getNewLine: () => "\n",
        });

  expect(message).toBe("");
}

function expectGeneratedToTypecheck(programName: string, output: string): void {
  runTypecheck({ ...virtualBaseFiles(), [`/virtual/${programName}.ts`]: output });
}

/** Typecheck several generated modules together (keys are module base names). */
function expectModulesToTypecheck(modules: Record<string, string>): void {
  const files = virtualBaseFiles();
  for (const [name, source] of Object.entries(modules)) {
    files[`/virtual/${name}.ts`] = source;
  }
  runTypecheck(files);
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
  ["edge-identifier.abi.json", "identifier.ts"],
  ["edge-storage-variables.abi.json", "storage-variables.ts"],
  ["edge-mixed-async.abi.json", "mixed-async.ts"],
  ["edge-dex.abi.json", "dex.ts"],
  ["edge-optional-nonzeroable-fields.abi.json", "optional-nonzeroable-fields.ts"],
  ["edge-input-name-collisions.abi.json", "input-name-collisions.ts"],
];

describe("codegen goldens", () => {
  for (const [fixtureFile, goldenFile] of FIXTURE_PAIRS) {
    it(`generates expected output for ${fixtureFile}`, async () => {
      const abi = loadAbi(fixtureFile);
      const output = generateBindings(abi);
      await expect(output).toMatchFileSnapshot(resolve(__dirname, "__goldens__", goldenFile));
    });
  }

  it("generates expected BaseContract output", async () => {
    const output = generateBaseContract();
    await expect(output).toMatchFileSnapshot(resolve(__dirname, "__goldens__", "base-contract.ts"));
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

  it("a generated wrapper is assignable to a deploy target (programId stays public)", () => {
    // Regression guard for `ctx.deploy(wrapper)`: a wrapper structurally
    // satisfies `ProgramDeploymentTarget`'s `{ readonly programId: string }`
    // arm only while `BaseContract.programId` is public. Flipping it back to
    // `protected` makes TypeScript treat the member nominally and this fails.
    const assertion = [
      'import { BaseContract } from "./BaseContract.js";',
      "declare const wrapper: BaseContract;",
      "const _deployTarget: { readonly programId: string } = wrapper;",
      "void _deployTarget;",
    ].join("\n");
    expectGeneratedToTypecheck("deploy-target-assertion", assertion);
  });
});

const INTERFACE_HELPERS_HELPERS = [
  {
    helperName: "asPoolToken",
    sourceRecord: "Token",
    sourceProgram: "stable_token.aleo",
    schema: {
      owner: "address.private",
      amount: "u128.private",
      _version: "u8.public",
      _nonce: "group.public",
    },
  },
];

describe("codegen interface helpers", () => {
  it("generates asPoolToken helper for the interface-helpers fixture", async () => {
    const abi = loadAbi("interface-helpers.abi.json");
    const output = generateBindings(abi, [abi], { dynamicRecords: INTERFACE_HELPERS_HELPERS });
    await expect(output).toMatchFileSnapshot(
      resolve(__dirname, "__goldens__", "interface-helpers.ts"),
    );
  });

  it("interface-helpers.ts typechecks", () => {
    const abi = loadAbi("interface-helpers.abi.json");
    const output = generateBindings(abi, [abi], { dynamicRecords: INTERFACE_HELPERS_HELPERS });
    expectGeneratedToTypecheck("interface-helpers", output);
  });
});

describe("composite input widening typechecks", () => {
  // Struct with a field-array + a record, exercising the local `${Name}Input`
  // interfaces for transition args.
  const PROOFS_ABI = JSON.stringify({
    program: "proofs.aleo",
    structs: [
      {
        path: ["MerkleProof"],
        fields: [
          { name: "siblings", ty: { Array: [{ Primitive: "Field" }, 3] } },
          { name: "leaf_index", ty: { Primitive: { UInt: "U32" } } },
        ],
      },
    ],
    records: [
      {
        path: ["Note"],
        fields: [
          { name: "owner", ty: { Primitive: "Address" } },
          { name: "value", ty: { Primitive: { UInt: "U64" } } },
        ],
      },
    ],
    mappings: [],
    storage_variables: [],
    transitions: [
      {
        name: "verify",
        is_async: false,
        inputs: [
          {
            name: "proof",
            ty: { Plaintext: { Struct: { path: ["MerkleProof"], program: null } } },
            mode: "None",
          },
        ],
        outputs: [{ ty: { Plaintext: { Primitive: "Boolean" } }, mode: "None" }],
      },
      {
        name: "spend",
        is_async: false,
        inputs: [{ name: "note", ty: { Record: { path: ["Note"], program: null } }, mode: "None" }],
        outputs: [{ ty: { Record: { path: ["Note"], program: null } }, mode: "None" }],
      },
    ],
  });

  it("accepts raw composite literals, re-spends branded outputs, and keeps cross-type safety", () => {
    const output = generateBindings(parseAbi(PROOFS_ABI));
    const assertions = [
      "",
      'import { Leo } from "./BaseContract.js";',
      "declare const c: Proofs;",
      "async function _check() {",
      // Raw bigint/number flow into a struct-with-field-array input slot:
      "  void c.verify.locally({ proof: { siblings: [1n, 2n, 3n], leaf_index: 0 } });",
      // A branded record output re-spends into the widened input slot, no conversion:
      '  const note = await c.spend.locally({ note: { owner: { address: "aleo1x" }, value: 5n, _nonce: 0n } });',
      "  void c.spend.locally({ note });",
      // Cross-type safety preserved: a branded LeoField is not an AddressInput.
      "  // @ts-expect-error LeoField is not assignable to the AddressInput `owner` slot",
      "  void c.spend.locally({ note: { owner: Leo.field(1n), value: 5n, _nonce: 0n } });",
      "}",
      "void _check;",
    ].join("\n");
    expectGeneratedToTypecheck("proofs", `${output}\n${assertions}`);
  });

  it("cross-program external struct inputs typecheck against the producer's input interface", () => {
    const registry = parseAbi(
      JSON.stringify({
        program: "registry.aleo",
        structs: [
          {
            path: ["TokenInfo"],
            fields: [
              { name: "token_id", ty: { Primitive: "Field" } },
              { name: "admin", ty: { Primitive: "Address" } },
            ],
          },
        ],
        records: [],
        mappings: [],
        storage_variables: [],
        transitions: [
          {
            name: "make",
            is_async: false,
            inputs: [{ name: "id", ty: { Plaintext: { Primitive: "Field" } }, mode: "None" }],
            outputs: [
              {
                ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: null } } },
                mode: "None",
              },
            ],
          },
        ],
      }),
    );
    // The consumer also declares a local struct literally named `WidenInput`,
    // which would clash with the `type WidenInput` import the external alias
    // needs (TS2440) unless the import is aliased. The resolver mangles the
    // import to `WidenInput_` here.
    const consumer = parseAbi(
      JSON.stringify({
        program: "consumer.aleo",
        structs: [
          { path: ["WidenInput"], fields: [{ name: "n", ty: { Primitive: { UInt: "U64" } } }] },
        ],
        records: [],
        mappings: [],
        storage_variables: [],
        transitions: [
          {
            name: "submit",
            is_async: false,
            inputs: [
              {
                name: "info",
                ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } } },
                mode: "None",
              },
              {
                name: "extra",
                ty: { Plaintext: { Struct: { path: ["WidenInput"], program: null } } },
                mode: "None",
              },
            ],
            outputs: [
              {
                ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } } },
                mode: "None",
              },
            ],
          },
        ],
      }),
    );
    const consumerOutput = generateBindings(consumer, [consumer, registry]);
    // Import is aliased away from the local `WidenInput` interface…
    expect(consumerOutput).toContain("type WidenInput as WidenInput_");
    expect(consumerOutput).toContain(
      "export type Registry_TokenInfoInput = WidenInput_<Registry_TokenInfo>;",
    );
    expect(consumerOutput).toContain("export interface WidenInput {");
    expectModulesToTypecheck({
      Registry: generateBindings(registry, [registry, consumer]),
      Consumer: consumerOutput,
    });
  });
});
