import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { PlaintextType, ProgramABI, RecordRef, StructRef } from "../abi-types.js";
import { CodegenError } from "./codegen-error.js";
import {
  assertTypechainModuleNamesUnique,
  generateBaseContract,
  generateBindings,
} from "./typescript-generator.js";

/** Shorthand for creating a StructRef in tests */
function sref(name: string, program: string | null = null): StructRef {
  return { path: [name], program };
}

/** Shorthand for creating a RecordRef in tests */
function rref(name: string, program: string | null = null): RecordRef {
  return { path: [name], program };
}

function expectGeneratedModulesToTypecheck(outputs: Record<string, string>): void {
  const files: Record<string, string> = {
    "/virtual/package.json": '{ "type": "module" }',
    "/virtual/BaseContract.ts": generateBaseContract(),
    "/virtual/core.d.ts": "export interface LionDenRuntimeEnvironment { network: unknown }",
    "/virtual/network.d.ts": [
      'export declare function decryptRecordCiphertext(ciphertext: string, viewKey: string, options?: { readonly network?: "testnet" | "mainnet" }): Promise<string>;',
      'export declare function decryptValueCiphertext(ciphertext: string, viewKey: string, tpk: string, programId: string, transitionName: string, globalIndex: number, options?: { readonly network?: "testnet" | "mainnet" }): Promise<string>;',
      'export declare function deriveViewKey(privateKey: string, options?: { readonly network?: "testnet" | "mainnet" }): Promise<string>;',
      "export declare function programAddressFromProgramId(programId: string): string;",
      "export declare class LocalVmExecutionError extends Error {",
      '  readonly kind: "LocalVmExecutionError";',
      "  readonly programId: string;",
      "  readonly transitionName: string;",
      "  constructor(message: string, context: { readonly programId: string; readonly transitionName: string; readonly cause?: unknown });",
      "}",
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
    ].join("\n"),
  };
  for (const [programName, output] of Object.entries(outputs)) {
    files[`/virtual/${programName}.ts`] = output;
  }

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
      if (moduleName === "@lionden/network") {
        return {
          resolvedFileName: "/virtual/network.d.ts",
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
      if (moduleName.startsWith("./") && moduleName.endsWith(".js")) {
        return {
          resolvedFileName: `/virtual/${moduleName.slice(2, -3)}.ts`,
          extension: ts.Extension.Ts,
        };
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
  expectGeneratedModulesToTypecheck({ [programName]: output });
}

const SAMPLE_ABI: ProgramABI = {
  program: "token.aleo",
  structs: [
    {
      path: ["TokenInfo"],
      fields: [
        { name: "supply", ty: { Primitive: { UInt: "U64" } } },
        { name: "admin", ty: { Primitive: "Address" } },
      ],
    },
  ],
  records: [
    {
      path: ["Token"],
      fields: [
        { name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const },
        { name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "Private" as const },
      ],
    },
  ],
  mappings: [
    {
      name: "balances",
      key: { Primitive: "Address" as const },
      value: { Primitive: { UInt: "U64" } },
    },
  ],
  storage_variables: [],
  transitions: [
    {
      name: "mint",
      is_async: false,
      inputs: [
        {
          name: "receiver",
          ty: { Plaintext: { Primitive: "Address" as const } },
          mode: "Private" as const,
        },
        {
          name: "amount",
          ty: { Plaintext: { Primitive: { UInt: "U64" } } },
          mode: "Public" as const,
        },
      ],
      outputs: [{ ty: { Record: rref("Token") }, mode: "Private" as const }],
    },
    {
      name: "transfer",
      is_async: false,
      inputs: [
        {
          name: "receiver",
          ty: { Plaintext: { Primitive: "Address" as const } },
          mode: "Private" as const,
        },
        {
          name: "amount",
          ty: { Plaintext: { Primitive: { UInt: "U64" } } },
          mode: "Public" as const,
        },
      ],
      outputs: [],
    },
  ],
};

const SIGNATURE_PLAINTEXT = { Primitive: "Signature" } as const satisfies PlaintextType;

function baseUnsupportedPrimitiveAbi(): ProgramABI {
  return {
    program: "signature_probe.aleo",
    structs: [
      {
        path: ["Envelope"],
        fields: [{ name: "payload", ty: { Primitive: { UInt: "U64" } } }],
      },
    ],
    records: [
      {
        path: ["Receipt"],
        fields: [
          { name: "owner", ty: { Primitive: "Address" }, mode: "Private" },
          { name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "Private" },
        ],
      },
    ],
    mappings: [
      {
        name: "balances",
        key: { Primitive: "Address" },
        value: { Primitive: { UInt: "U64" } },
      },
    ],
    storage_variables: [{ name: "admin", ty: { Plaintext: { Primitive: "Address" } } }],
    transitions: [
      {
        name: "sign",
        is_async: false,
        inputs: [
          {
            name: "amount",
            ty: { Plaintext: { Primitive: { UInt: "U64" } } },
            mode: "Private",
          },
        ],
        outputs: [],
      },
    ],
  };
}

function expectUnsupportedPrimitive(
  abi: ProgramABI,
  abiPath: string,
  primitive = "Signature",
): void {
  let caught: unknown;
  try {
    generateBindings(abi);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(CodegenError);
  expect((caught as Error).message).toContain(`program ${abi.program}`);
  expect((caught as Error).message).toContain(`ABI path ${abiPath}`);
  expect((caught as Error).message).toContain(
    `Primitive::${primitive} is not supported by generated bindings yet`,
  );
}

describe("Leo 4.1 ABI extensions", () => {
  it("rejects executable functions with non-empty const_parameters", () => {
    const abi: ProgramABI = {
      program: "const_demo.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "main",
          is_async: false,
          inputs: [],
          outputs: [],
          const_parameters: [{ name: "N", type: "u8" }],
        },
      ],
    };

    expect(() => generateBindings(abi)).toThrow(/const_parameters/);
  });

  it("does not generate view query wrappers yet", () => {
    const abi: ProgramABI = {
      program: "view_demo.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
      views: [
        {
          name: "balance",
          inputs: [],
          outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" }],
        },
      ],
    };

    const output = generateBindings(abi);
    expect(output).not.toContain("readonly balance");
  });
});

describe("unsupported primitive validation", () => {
  it("rejects Signature in transition inputs", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      transitions: [
        {
          name: "sign",
          is_async: false,
          inputs: [{ name: "signature", ty: { Plaintext: SIGNATURE_PLAINTEXT }, mode: "Private" }],
          outputs: [],
        },
      ],
    };

    expectUnsupportedPrimitive(abi, "transitions[0].inputs[0].ty.Plaintext.Primitive");
  });

  it("rejects Signature in transition outputs before emitting unsafe private output bindings", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      transitions: [
        {
          name: "sign",
          is_async: false,
          inputs: [],
          outputs: [{ ty: { Plaintext: SIGNATURE_PLAINTEXT }, mode: "Private" }],
        },
      ],
    };

    expectUnsupportedPrimitive(abi, "transitions[0].outputs[0].ty.Plaintext.Primitive");
  });

  it("rejects Signature in struct fields", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      structs: [{ path: ["Envelope"], fields: [{ name: "signature", ty: SIGNATURE_PLAINTEXT }] }],
    };

    expectUnsupportedPrimitive(abi, "structs[0].fields[0].ty.Primitive");
  });

  it("rejects Signature in record fields", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      records: [
        {
          path: ["Receipt"],
          fields: [
            { name: "owner", ty: { Primitive: "Address" }, mode: "Private" },
            { name: "signature", ty: SIGNATURE_PLAINTEXT, mode: "Private" },
          ],
        },
      ],
    };

    expectUnsupportedPrimitive(abi, "records[0].fields[1].ty.Primitive");
  });

  it("rejects Signature in mapping keys", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      mappings: [
        {
          name: "seen",
          key: SIGNATURE_PLAINTEXT,
          value: { Primitive: "Boolean" },
        },
      ],
    };

    expectUnsupportedPrimitive(abi, "mappings[0].key.Primitive");
  });

  it("rejects Signature in mapping values", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      mappings: [
        {
          name: "signatures",
          key: { Primitive: "Address" },
          value: SIGNATURE_PLAINTEXT,
        },
      ],
    };

    expectUnsupportedPrimitive(abi, "mappings[0].value.Primitive");
  });

  it("rejects Signature in storage variables", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      storage_variables: [{ name: "stored_signature", ty: { Plaintext: SIGNATURE_PLAINTEXT } }],
    };

    expectUnsupportedPrimitive(abi, "storage_variables[0].ty.Plaintext.Primitive");
  });

  it("rejects Signature in array elements", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      structs: [
        {
          path: ["Envelope"],
          fields: [{ name: "signatures", ty: { Array: [SIGNATURE_PLAINTEXT, 2] } }],
        },
      ],
    };

    expectUnsupportedPrimitive(abi, "structs[0].fields[0].ty.Array[0].Primitive");
  });

  it("rejects Signature in Optional inner types", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      structs: [
        {
          path: ["Envelope"],
          fields: [{ name: "maybe_signature", ty: { Optional: SIGNATURE_PLAINTEXT } }],
        },
      ],
    };

    expectUnsupportedPrimitive(abi, "structs[0].fields[0].ty.Optional.Primitive");
  });

  it("rejects future unknown string primitives instead of falling back to generic codegen", () => {
    const base = baseUnsupportedPrimitiveAbi();
    const abi: ProgramABI = {
      ...base,
      transitions: [
        {
          name: "future",
          is_async: false,
          inputs: [
            {
              name: "future",
              ty: { Plaintext: { Primitive: "FutureSignature" as any } },
              mode: "Private",
            },
          ],
          outputs: [],
        },
      ],
    };

    expectUnsupportedPrimitive(
      abi,
      "transitions[0].inputs[0].ty.Plaintext.Primitive",
      "FutureSignature",
    );
  });
});

describe("generateBindings", () => {
  it("generates struct interfaces", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export interface TokenInfo");
    expect(output).toContain("readonly supply: bigint;");
    expect(output).toContain("readonly admin: LeoAddress;");
  });

  it("generates record interfaces with owner and _nonce", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export interface Token");
    expect(output).toContain("readonly owner: LeoAddress;");
    expect(output).toContain("readonly amount: bigint;");
    expect(output).toContain("readonly _nonce: LeoGroup;");
  });

  it("generates struct serializers", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export function serializeTokenInfo");
  });

  it("generates record serializers using Leo syntax, not JSON", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain(
      "export function serializeToken(value: TokenInput, context?: TransitionInputContext): string",
    );
    // Should NOT use JSON.stringify
    expect(output).not.toContain("JSON.stringify");
  });

  it("emits an async decrypt<Name> free function per record", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain(
      "export async function decryptToken(ciphertext: string, key: RecordDecryptionKey): Promise<Token>",
    );
    expect(output).toContain("BaseContract.decryptRecord(ciphertext, key, deserializeToken);");
  });

  it("does NOT emit any decrypt helpers for record-less programs", () => {
    const abiNoRecords: ProgramABI = {
      ...SAMPLE_ABI,
      records: [],
      // mint/transfer reference Token outputs in SAMPLE_ABI; drop them so the
      // generator stays valid without record metadata.
      transitions: [
        {
          name: "ping",
          is_async: false,
          inputs: [],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abiNoRecords);
    expect(output).not.toContain("decryptToken");
    expect(output).not.toMatch(/export async function decrypt\w+/);
  });

  it("serializes record nonce for valid record inputs", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain('fields.push("_nonce: " + BaseContract.serializeGroup(value._nonce');
  });

  it("serializes record inputs via serializeRecord, not JSON.stringify", () => {
    const abi: ProgramABI = {
      program: "wallet.aleo",
      structs: [],
      records: [
        {
          path: ["Coin"],
          fields: [
            { name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const },
            { name: "value", ty: { Primitive: { UInt: "U64" } }, mode: "Private" as const },
          ],
        },
      ],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "spend",
          is_async: false,
          inputs: [{ name: "coin", ty: { Record: rref("Coin") }, mode: "Private" as const }],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abi);
    // The transition method should serialize via serializeCoin(), not JSON.stringify
    expect(output).toContain(
      'serializeCoin(args.coin as CoinInput, this.inputContext("spend", "coin"))',
    );
    expect(output).not.toContain("JSON.stringify");
  });

  it("generates contract class extending BaseContract", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export class TokenContract extends BaseContract");
    expect(output).toContain('super("token.aleo", options);');
  });

  it("generates typed transition methods", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("readonly mint = {");
    expect(output).toContain(
      "locally: async (args: { readonly receiver: AddressInput; readonly amount: bigint }, options?: LocalExecutionOptions): Promise<Token>",
    );
    expect(output).toContain(
      "failsLocally: async (args: { readonly receiver: AddressInput; readonly amount: bigint }, options?: LocalExecutionOptions): Promise<void>",
    );
    expect(output).toContain(
      "captureLocalFailure: async (args: { readonly receiver: AddressInput; readonly amount: bigint }, options?: LocalExecutionOptions): Promise<LocalTransitionError>",
    );
    expect(output).toContain(
      "submitted: async (args: { readonly receiver: AddressInput; readonly amount: bigint }, options?: OnChainExecutionOptions): Promise<SubmittedTransition>",
    );
    expect(output).toContain("): Promise<Token>");
    expect(output).toContain("readonly transfer = {");
    expect(output).toContain("): Promise<void>");
  });

  it("generates local and on-chain transition helpers", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("const _args: string[]");
    expect(output).toContain('this.executeLocal("mint"');
    expect(output).toContain('await this.expectLocalFailure("mint"');
    expect(output).toContain('return this.expectLocalFailure("mint"');
    expect(output).toContain('return this.submitTransition("mint"');
    expect(output).toContain('return this.expectAcceptedTyped("transfer"');
  });

  it("deserializes transition outputs to proper JS types", () => {
    const output = generateBindings(SAMPLE_ABI);
    // mint() returns Token (record) — should call deserializeToken, not return raw string
    expect(output).toContain('deserializeToken(this.outputAt(_result, "mint", 0))');
    expect(output).not.toContain("_result.outputs as any");
  });

  it("generates struct and record deserializers", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export function deserializeTokenInfo(value: string): TokenInfo");
    expect(output).toContain("BaseContract.parseBigInt");
    expect(output).toContain("BaseContract.parseAddress");
    expect(output).toContain("export function deserializeToken(value: string): Token");
  });

  it("deserializes primitive return types without struct deserializer", () => {
    const abi: ProgramABI = {
      program: "math.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "add",
          is_async: false,
          inputs: [
            {
              name: "a",
              ty: { Plaintext: { Primitive: { UInt: "U64" } } },
              mode: "Private" as const,
            },
            {
              name: "b",
              ty: { Plaintext: { Primitive: { UInt: "U64" } } },
              mode: "Private" as const,
            },
          ],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Private" as const },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    // Should deserialize using parseBigInt, not return raw string
    expect(output).toContain('BaseContract.parseBigInt(this.outputAt(_result, "add", 0))');
  });

  it("generates mapping accessors with deserialized values", () => {
    const output = generateBindings(SAMPLE_ABI);
    // Mappings are exposed under a `mappings` namespace mirroring Leo's read ops.
    expect(output).toContain("readonly mappings = {");
    expect(output).toContain("balances: {");
    expect(output).toContain("contains: async (key: AddressInput): Promise<boolean> =>");
    expect(output).toContain("get: async (key: AddressInput): Promise<bigint> =>");
    expect(output).toContain(
      "getOrUse: async (key: AddressInput, def: bigint): Promise<bigint> =>",
    );
    expect(output).toContain("tryGet: async (key: AddressInput): Promise<bigint | null> =>");
    expect(output).toContain('this.mappingContains("balances"');
    expect(output).toContain('this.requireMappingRaw("balances"');
    expect(output).toContain('this.queryMapping("balances"');
    // Should deserialize the returned value, not return raw string
    expect(output).toContain("if (_result === null) return null;");
    expect(output).toContain("BaseContract.parseBigInt(_result)");
  });

  it("generates factory function", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain(
      "export function createTokenContract(options?: BaseContractOptions): TokenContract",
    );
  });

  it("resolves second-order class name collision", () => {
    // program "token.aleo" → base class "Token", record "Token" → first suffix "TokenContract",
    // struct "TokenContract" → second suffix "TokenContractContract"
    const abi: ProgramABI = {
      program: "token.aleo",
      structs: [
        {
          path: ["TokenContract"],
          fields: [{ name: "value", ty: { Primitive: { UInt: "U64" } } }],
        },
      ],
      records: [
        {
          path: ["Token"],
          fields: [{ name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const }],
        },
      ],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export class TokenContractContract extends BaseContract");
    expect(output).toContain(
      "export function createTokenContractContract(options?: BaseContractOptions): TokenContractContract",
    );
    // Interfaces must still use the original names
    expect(output).toContain("export interface Token {");
    expect(output).toContain("export interface TokenContract {");
  });

  it("includes auto-generated header", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("Auto-generated by @lionden/leo-compiler");
    expect(output).toContain("Program: token.aleo");
  });

  it("deserializes arrays using BaseContract.parseArray, not naive split", () => {
    const abi: ProgramABI = {
      program: "grid.aleo",
      structs: [
        {
          path: ["Point"],
          fields: [
            { name: "x", ty: { Primitive: { UInt: "U32" } } },
            { name: "y", ty: { Primitive: { UInt: "U32" } } },
          ],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "get_points",
          is_async: false,
          inputs: [],
          outputs: [
            {
              ty: { Plaintext: { Array: [{ Struct: sref("Point") }, 3] } },
              mode: "Private" as const,
            },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    // Should use depth-aware parseArray, not .split(", ")
    expect(output).toContain("BaseContract.parseArray(");
    expect(output).not.toContain('.split(", ")');
    // Each element should be deserialized through the struct deserializer
    expect(output).toContain("deserializePoint(e)");
  });

  it("generates distinct interfaces for module-scoped structs", () => {
    const abi: ProgramABI = {
      program: "test.aleo",
      structs: [
        { path: ["a", "Thing"], fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }] },
        { path: ["b", "Thing"], fields: [{ name: "y", ty: { Primitive: { UInt: "U64" } } }] },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export interface A_Thing");
    expect(output).toContain("export interface B_Thing");
    expect(output).toContain("readonly x: number;");
    expect(output).toContain("readonly y: bigint;");
  });
});

describe("generateBaseContract", () => {
  it("generates BaseContract class with execute and queryMapping", () => {
    const output = generateBaseContract();
    expect(output).toContain("export abstract class BaseContract");
    expect(output).toContain("readonly programId: string;");
    expect(output).toContain("address(): LeoAddress");
    expect(output).toContain("connect(lre: LionDenRuntimeEnvironment)");
    expect(output).toContain("protected getLre()");
    expect(output).toContain("protected async executeLocal(");
    expect(output).toContain("protected async submitTransition(");
    expect(output).toContain("protected async expectAccepted(");
    expect(output).toContain("protected async queryMapping(");
    expect(output).toContain("SubmittedTransition");
    expect(output).toContain("LocalExecutionOptions");
    expect(output).toContain("OnChainExecutionOptions");
  });

  it("includes parseArray static method for depth-aware array splitting", () => {
    const output = generateBaseContract();
    expect(output).toContain("static parseArray(value: string): string[]");
  });
});

describe("async transitions with Future output", () => {
  it("generates void return for transitions with Future output", () => {
    const abi: ProgramABI = {
      program: "vault.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "deposit",
          is_async: true,
          inputs: [
            {
              name: "amount",
              ty: { Plaintext: { Primitive: { UInt: "U64" } } },
              mode: "Public" as const,
            },
          ],
          outputs: [{ ty: { Future: "vault.aleo" }, mode: "Private" as const }],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("readonly deposit = {");
    expect(output).toContain("): Promise<void>");
  });

  it("generates tuple return for mixed Record + Future outputs", () => {
    const abi: ProgramABI = {
      program: "token.aleo",
      structs: [],
      records: [
        {
          path: ["Token"],
          fields: [
            { name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const },
            { name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "Private" as const },
          ],
        },
      ],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "mint_and_finalize",
          is_async: true,
          inputs: [
            {
              name: "receiver",
              ty: { Plaintext: { Primitive: "Address" as const } },
              mode: "Public" as const,
            },
          ],
          outputs: [
            { ty: { Record: rref("Token") }, mode: "Private" as const },
            { ty: { Future: "token.aleo" }, mode: "Private" as const },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    // Multiple outputs → tuple return type
    expect(output).toContain("): Promise<[Token, void]>");
  });
});

describe("DynamicRecord handling", () => {
  it("generates string type for DynamicRecord (pre-encoded Leo record)", () => {
    const abi: ProgramABI = {
      program: "proxy.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "forward",
          is_async: false,
          inputs: [{ name: "record", ty: "DynamicRecord", mode: "Private" as const }],
          outputs: [{ ty: "DynamicRecord", mode: "Private" as const }],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("record: DynamicRecordInput");
    expect(output).toContain("): Promise<LeoDynamicRecord>");
    // Should pass through as-is, not JSON.stringify
    expect(output).not.toContain("JSON.stringify");
  });
});

describe("external references", () => {
  it("uses branded plaintext for unresolved external structs", () => {
    const abi: ProgramABI = {
      program: "consumer.aleo",
      structs: [],
      records: [],
      mappings: [
        {
          name: "metadata",
          key: { Primitive: "Field" as const },
          value: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } },
        },
      ],
      storage_variables: [],
      transitions: [
        {
          name: "submit",
          is_async: false,
          inputs: [
            {
              name: "info",
              ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } } },
              mode: "Private" as const,
            },
          ],
          outputs: [
            {
              ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } } },
              mode: "Private" as const,
            },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("info: PlaintextInput");
    expect(output).toContain("metadata: {");
    expect(output).toContain("get: async (key: FieldInput): Promise<LeoPlaintext> =>");
    expect(output).toContain("tryGet: async (key: FieldInput): Promise<LeoPlaintext | null> =>");
    expect(output).toContain("BaseContract.serializePlaintext");
    expect(output).toContain("BaseContract.parsePlaintext");
  });

  it("uses branded dynamic records for unresolved external records", () => {
    const abi: ProgramABI = {
      program: "consumer.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "forward",
          is_async: false,
          inputs: [
            {
              name: "record",
              ty: { Record: { path: ["credits"], program: "credits.aleo" } },
              mode: "Private" as const,
            },
          ],
          outputs: [
            {
              ty: { Record: { path: ["credits"], program: "credits.aleo" } },
              mode: "Private" as const,
            },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("record: DynamicRecordInput");
    expect(output).toContain("): Promise<LeoDynamicRecord>");
    expect(output).toContain("BaseContract.serializeDynamicRecord");
    expect(output).toContain("BaseContract.parseDynamicRecord");
  });

  it("imports typed external structs when the referenced ABI is available", () => {
    const registry: ProgramABI = {
      program: "registry.aleo",
      structs: [
        {
          path: ["TokenInfo"],
          fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const consumer: ProgramABI = {
      program: "consumer.aleo",
      structs: [],
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
              mode: "Private" as const,
            },
          ],
          outputs: [
            {
              ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } } },
              mode: "Private" as const,
            },
          ],
        },
      ],
    };

    const output = generateBindings(consumer, [consumer, registry]);
    expect(output).toContain('from "./Registry.js"');
    expect(output).toContain("readonly info: Registry_TokenInfo");
    expect(output).toContain("Promise<Registry_TokenInfo>");
    expect(output).toContain(
      'serializeRegistry_TokenInfo(args.info as Registry_TokenInfoInput, this.inputContext("submit", "info"))',
    );
    expect(output).toContain('deserializeRegistry_TokenInfo(this.outputAt(_result, "submit", 0))');
  });

  it("imports typed external records when the referenced ABI is available", () => {
    const credits: ProgramABI = {
      program: "credits.aleo",
      structs: [],
      records: [
        {
          path: ["Credit"],
          fields: [
            { name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const },
            { name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "Private" as const },
          ],
        },
      ],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const consumer: ProgramABI = {
      program: "consumer.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "forward",
          is_async: false,
          inputs: [
            {
              name: "record",
              ty: { Record: { path: ["Credit"], program: "credits.aleo" } },
              mode: "Private" as const,
            },
          ],
          outputs: [
            {
              ty: { Record: { path: ["Credit"], program: "credits.aleo" } },
              mode: "Private" as const,
            },
          ],
        },
      ],
    };

    const output = generateBindings(consumer, [consumer, credits]);
    expect(output).toContain('from "./Credits.js"');
    expect(output).toContain("readonly record: Credits_Credit");
    expect(output).toContain("Promise<Credits_Credit>");
    expect(output).toContain(
      'serializeCredits_Credit(args.record as Credits_CreditInput, this.inputContext("forward", "record"))',
    );
    // Resolved external record bindings carry an `.output` matcher value so
    // callers can write `accepted.outputs.match(Credits_Credit.output.from(...)).decrypt(key)`.
    expect(output).toContain("export const Credits_Credit = {");
    expect(output).toContain("output: createRecordOutputMatcher<_Credits_Credit>({");
    expect(output).toContain('program: "credits.aleo"');
    expect(output).toContain('recordName: "Credit"');
    expect(output).toContain("deserialize: deserializeCredits_Credit");
  });
});

describe("Optional type handling", () => {
  it("generates nullable field type in struct interface", () => {
    const abi: ProgramABI = {
      program: "config.aleo",
      structs: [
        {
          path: ["Settings"],
          fields: [
            { name: "admin", ty: { Primitive: "Address" } },
            { name: "backup", ty: { Optional: { Primitive: "Address" } } },
          ],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("readonly admin: LeoAddress;");
    expect(output).toContain("readonly backup: LeoAddress | null;");
  });

  it("serializes Optional fields as lowered is_some/val struct", () => {
    const abi: ProgramABI = {
      program: "config.aleo",
      structs: [
        {
          path: ["Settings"],
          fields: [
            { name: "admin", ty: { Primitive: "Address" } },
            { name: "backup", ty: { Optional: { Primitive: "Address" } } },
          ],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    // Should use is_some/val lowered struct form
    expect(output).toContain("is_some: true, val:");
    expect(output).toContain("is_some: false, val:");
  });

  it("deserializes Optional fields by parsing is_some/val struct", () => {
    const abi: ProgramABI = {
      program: "config.aleo",
      structs: [
        {
          path: ["Settings"],
          fields: [{ name: "backup", ty: { Optional: { Primitive: { UInt: "U64" } } } }],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    // Should parse the struct and check is_some
    expect(output).toContain("BaseContract.parseStruct(");
    expect(output).toContain('parseBoolean(_opt["is_some"]');
    expect(output).toContain('_opt["val"]');
  });

  it("serializes Optional struct fields with a lowered None value", () => {
    const abi: ProgramABI = {
      program: "config.aleo",
      structs: [
        {
          path: ["Inner"],
          fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }],
        },
        {
          path: ["Settings"],
          fields: [
            {
              name: "backup",
              ty: { Optional: { Struct: { path: ["Inner"], program: null } } },
            },
          ],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain(
      'serializeInner(value.backup as InnerInput, BaseContract.childInputContext(context, "backup"))',
    );
    expect(output).toContain("{ is_some: false, val: { x: 0u32 } }");
    expect(output).not.toContain("serializeUnsupportedOptionalNone");
  });

  it("emits IIFE-throw fallback for non-zeroable Optional inner (external Struct ref)", () => {
    const abi: ProgramABI = {
      program: "consumer.aleo",
      structs: [
        {
          path: ["Settings"],
          fields: [
            {
              name: "external",
              ty: { Optional: { Struct: { path: ["ExternalInfo"], program: "producer.aleo" } } },
            },
          ],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("readonly external: LeoPlaintext | null;");
    expect(output).toContain("BaseContract.serializeUnsupportedOptionalNone");
    expect(output).not.toContain("is_some: false, val:");
  });
});

describe("storage variables", () => {
  it("generates storage interface and runtime accessors for ABI storage variables", () => {
    const abi: ProgramABI = {
      program: "vault.aleo",
      structs: [
        {
          path: ["Policy"],
          fields: [{ name: "limit", ty: { Primitive: { UInt: "U64" } } }],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [
        { name: "admin", ty: { Plaintext: { Primitive: "Address" } } },
        {
          name: "bool_arr",
          ty: {
            Plaintext: { Array: [{ Primitive: "Boolean" }, 3] },
          },
        },
        { name: "bool_vector", ty: { Vector: { Plaintext: { Primitive: "Boolean" } } } },
        {
          name: "policies",
          ty: { Vector: { Plaintext: { Struct: { path: ["Policy"], program: null } } } },
        },
      ],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export interface VaultStorage");
    expect(output).toContain("readonly admin: LeoAddress;");
    expect(output).toContain("readonly bool_arr: ReadonlyArray<boolean>;");
    expect(output).toContain("readonly bool_vector: boolean[];");
    expect(output).toContain("readonly policies: Policy[];");
    expect(output).toContain("readonly storage = {");
    expect(output).toContain("admin: {");
    expect(output).toContain("get: async (): Promise<LeoAddress> =>");
    expect(output).toContain("getOrUse: async (def: LeoAddress): Promise<LeoAddress> =>");
    expect(output).toContain("tryGet: async (): Promise<LeoAddress | null> =>");
    expect(output).toContain('this.requireStorageRaw("admin")');
    expect(output).toContain('this.queryStorage("admin")');
    expect(output).not.toContain("admin: {\n      get: async (key:");
    expect(output).toContain("return BaseContract.parseAddress(_result);");
    expect(output).toContain("boolArr: {");
    expect(output).toContain("get: async (): Promise<ReadonlyArray<boolean>> =>");
    expect(output).toContain('this.requireStorageRaw("bool_arr")');
    expect(output).toContain('this.queryStorage("bool_arr")');
    expect(output).toContain(
      "BaseContract.parseArray(_result).map((e: string) => BaseContract.parseBoolean(e))",
    );
    expect(output).toContain("boolVector: {");
    expect(output).toContain("len: async (): Promise<number> =>");
    expect(output).toContain('return this.queryStorageVectorLength("bool_vector");');
    expect(output).toContain("get: async (index: number): Promise<boolean> =>");
    expect(output).toContain('this.requireStorageVectorRaw("bool_vector", index)');
    expect(output).toContain("getOrUse: async (index: number, def: boolean): Promise<boolean> =>");
    expect(output).toContain('this.queryStorageVector("bool_vector", index)');
    expect(output).toContain("tryGet: async (index: number): Promise<boolean | null> =>");
    expect(output).not.toContain('this.requireStorageRaw("bool_vector")');
    expect(output).toContain("get: async (index: number): Promise<Policy> =>");
    expect(output).toContain('this.requireStorageVectorRaw("policies", index)');
    expect(output).toContain("return deserializePolicy(_result);");
    expect(output).toContain("if (_result === null) return def;");
    expect(output).toContain("if (_result === null) return null;");
    // Whole-vector accessors: getAll plus its toArray alias, reading via the
    // length-bounded queryStorageVectorAll helper.
    expect(output).toContain("getAll: async (): Promise<boolean[]> =>");
    expect(output).toContain("toArray: async (): Promise<boolean[]> =>");
    expect(output).toContain('this.queryStorageVectorAll("bool_vector");');
    expect(output).toContain('this.queryStorageVectorAll("policies");');
    expect(output).toContain("return _results.map((e: string) => BaseContract.parseBoolean(e));");
  });
});

describe("multiple outputs", () => {
  it("generates tuple return for multiple plaintext outputs", () => {
    const abi: ProgramABI = {
      program: "math.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "div_mod",
          is_async: false,
          inputs: [
            {
              name: "a",
              ty: { Plaintext: { Primitive: { UInt: "U64" } } },
              mode: "Private" as const,
            },
            {
              name: "b",
              ty: { Plaintext: { Primitive: { UInt: "U64" } } },
              mode: "Private" as const,
            },
          ],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Private" as const },
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Private" as const },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("): Promise<[bigint, bigint]>");
  });

  it("generates tuple return for mixed record and plaintext outputs", () => {
    const abi: ProgramABI = {
      program: "wallet.aleo",
      structs: [],
      records: [
        {
          path: ["Coin"],
          fields: [
            { name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const },
            { name: "value", ty: { Primitive: { UInt: "U64" } }, mode: "Private" as const },
          ],
        },
      ],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "split",
          is_async: false,
          inputs: [{ name: "coin", ty: { Record: rref("Coin") }, mode: "Private" as const }],
          outputs: [
            { ty: { Record: rref("Coin") }, mode: "Private" as const },
            { ty: { Record: rref("Coin") }, mode: "Private" as const },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("): Promise<[Coin, Coin]>");
    // Should deserialize both outputs
    expect(output).toContain('deserializeCoin(this.outputAt(_result, "split", 0))');
    expect(output).toContain('deserializeCoin(this.outputAt(_result, "split", 1))');
  });
});

describe("all primitive types in mappings", () => {
  it("generates mapping accessor for Boolean values", () => {
    const abi: ProgramABI = {
      program: "flags.aleo",
      structs: [],
      records: [],
      mappings: [
        {
          name: "claimed",
          key: { Primitive: "Address" as const },
          value: { Primitive: "Boolean" as const },
        },
      ],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("claimed: {");
    expect(output).toContain("get: async (key: AddressInput): Promise<boolean> =>");
    expect(output).toContain("tryGet: async (key: AddressInput): Promise<boolean | null> =>");
    expect(output).toContain("BaseContract.parseBoolean(_result)");
  });

  it("generates mapping accessor for Field keys", () => {
    const abi: ProgramABI = {
      program: "registry.aleo",
      structs: [],
      records: [],
      mappings: [
        {
          name: "entries",
          key: { Primitive: "Field" as const },
          value: { Primitive: "Address" as const },
        },
      ],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("entries: {");
    expect(output).toContain("get: async (key: FieldInput): Promise<LeoAddress> =>");
    expect(output).toContain("tryGet: async (key: FieldInput): Promise<LeoAddress | null> =>");
    expect(output).toContain("BaseContract.serializeField(key");
    // Key serialization is validated before querying.
    expect(output).toContain('this.queryMapping("entries"');
  });

  it("generates mapping accessor for struct values", () => {
    const abi: ProgramABI = {
      program: "dex.aleo",
      structs: [
        {
          path: ["Pair"],
          fields: [
            { name: "token_a", ty: { Primitive: "Address" as const } },
            { name: "token_b", ty: { Primitive: "Address" as const } },
          ],
        },
      ],
      records: [],
      mappings: [
        {
          name: "pairs",
          key: { Primitive: "Field" as const },
          value: { Struct: sref("Pair") },
        },
      ],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("pairs: {");
    expect(output).toContain("get: async (key: FieldInput): Promise<Pair> =>");
    expect(output).toContain("deserializePair(_result)");
  });

  it("generates mapping accessor for Boolean keys", () => {
    const abi: ProgramABI = {
      program: "init.aleo",
      structs: [],
      records: [],
      mappings: [
        {
          name: "initialized",
          key: { Primitive: "Boolean" as const },
          value: { Primitive: "Boolean" as const },
        },
      ],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("initialized: {");
    expect(output).toContain("contains: async (key: boolean): Promise<boolean> =>");
    expect(output).toContain("get: async (key: boolean): Promise<boolean> =>");
    expect(output).toContain("BaseContract.serializeBoolean(key");
  });

  it("generates mapping accessor for Array values", () => {
    const abi: ProgramABI = {
      program: "lists.aleo",
      structs: [],
      records: [],
      mappings: [
        {
          name: "rows",
          key: { Primitive: "Field" as const },
          value: { Array: [{ Primitive: { UInt: "U64" as const } }, 3] },
        },
      ],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("rows: {");
    expect(output).toContain("get: async (key: FieldInput): Promise<ReadonlyArray<bigint>> =>");
    expect(output).toContain("BaseContract.parseArray(_result)");
  });

  it("camelCases multi-word mapping names but preserves the on-chain name in queries", () => {
    const abi: ProgramABI = {
      program: "amm.aleo",
      structs: [],
      records: [],
      mappings: [
        {
          name: "lp_vouchers",
          key: { Primitive: "Field" as const },
          value: { Primitive: { UInt: "U128" as const } },
        },
      ],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    // Property key is camelCased ...
    expect(output).toContain("lpVouchers: {");
    expect(output).not.toContain("lp_vouchers: {");
    // ... but the network query still uses the original snake_case name.
    expect(output).toContain('this.queryMapping("lp_vouchers"');
    expect(output).toContain('this.requireMappingRaw("lp_vouchers"');
  });

  it("falls back to original Leo names when camelCasing collides", () => {
    const abi: ProgramABI = {
      program: "collide.aleo",
      structs: [],
      records: [],
      mappings: [
        {
          name: "lp_vouchers",
          key: { Primitive: "Field" as const },
          value: { Primitive: { UInt: "U128" as const } },
        },
        {
          name: "lpVouchers",
          key: { Primitive: "Field" as const },
          value: { Primitive: { UInt: "U128" as const } },
        },
      ],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    // Both collide on `lpVouchers`, so each is emitted under its quoted original name.
    expect(output).toContain('"lp_vouchers": {');
    expect(output).toContain('"lpVouchers": {');
    expect(output).not.toContain("lpVouchers: {");
  });
});

describe("struct with nested types", () => {
  it("generates interface for struct with array field", () => {
    const abi: ProgramABI = {
      program: "grid.aleo",
      structs: [
        {
          path: ["Board"],
          fields: [
            { name: "cells", ty: { Array: [{ Primitive: { UInt: "U8" } }, 9] } },
            { name: "turn", ty: { Primitive: { UInt: "U8" } } },
          ],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export interface Board");
    expect(output).toContain("readonly cells: ReadonlyArray<number>;");
    expect(output).toContain("readonly turn: number;");
  });

  it("generates interface for struct with nested struct field", () => {
    const abi: ProgramABI = {
      program: "geo.aleo",
      structs: [
        {
          path: ["Point"],
          fields: [
            { name: "x", ty: { Primitive: { Int: "I32" } } },
            { name: "y", ty: { Primitive: { Int: "I32" } } },
          ],
        },
        {
          path: ["Line"],
          fields: [
            { name: "start", ty: { Struct: sref("Point") } },
            { name: "end", ty: { Struct: sref("Point") } },
          ],
        },
      ],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export interface Point");
    expect(output).toContain("export interface Line");
    expect(output).toContain("readonly start: Point;");
    expect(output).toContain("readonly end: Point;");
    // Serializer should use serializePoint for nested structs
    expect(output).toContain(
      'serializePoint(value.start as PointInput, BaseContract.childInputContext(context, "start"))',
    );
    expect(output).toContain(
      'serializePoint(value.end as PointInput, BaseContract.childInputContext(context, "end"))',
    );
    // Deserializer should use deserializePoint
    expect(output).toContain("deserializePoint(");
  });
});

describe("serialization of all primitive types", () => {
  it("serializes Address as raw string (no suffix)", () => {
    const abi: ProgramABI = {
      program: "test.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "send",
          is_async: false,
          inputs: [
            {
              name: "to",
              ty: { Plaintext: { Primitive: "Address" as const } },
              mode: "Private" as const,
            },
          ],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain(
      'BaseContract.serializeAddress(args.to, this.inputContext("send", "to"))',
    );
  });

  it("serializes Boolean with String()", () => {
    const abi: ProgramABI = {
      program: "test.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "toggle",
          is_async: false,
          inputs: [
            {
              name: "flag",
              ty: { Plaintext: { Primitive: "Boolean" as const } },
              mode: "Private" as const,
            },
          ],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain(
      'BaseContract.serializeBoolean(args.flag, this.inputContext("toggle", "flag"))',
    );
  });

  it("serializes integers with type suffix", () => {
    const abi: ProgramABI = {
      program: "test.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "compute",
          is_async: false,
          inputs: [
            {
              name: "a",
              ty: { Plaintext: { Primitive: { UInt: "U32" } } },
              mode: "Private" as const,
            },
            {
              name: "b",
              ty: { Plaintext: { Primitive: { Int: "I64" } } },
              mode: "Private" as const,
            },
          ],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain(
      'BaseContract.serializeUInt(args.a, 32, this.inputContext("compute", "a"))',
    );
    expect(output).toContain(
      'BaseContract.serializeInt(args.b, 64, this.inputContext("compute", "b"))',
    );
  });

  it("serializes and deserializes Identifier primitives", () => {
    const abi: ProgramABI = {
      program: "governance.aleo",
      structs: [
        {
          path: ["StrategyConfig"],
          fields: [
            { name: "strategy", ty: { Primitive: "Identifier" } },
            { name: "fallback", ty: { Optional: { Primitive: "Identifier" } } },
            { name: "strategies", ty: { Array: [{ Primitive: "Identifier" }, 2] } },
          ],
        },
      ],
      records: [
        {
          path: ["Vote"],
          fields: [
            { name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const },
            { name: "strategy", ty: { Primitive: "Identifier" }, mode: "Private" as const },
          ],
        },
      ],
      mappings: [
        {
          name: "selected_strategy",
          key: { Primitive: "Identifier" as const },
          value: { Primitive: "Identifier" as const },
        },
      ],
      storage_variables: [],
      transitions: [
        {
          name: "route",
          is_async: false,
          inputs: [
            {
              name: "strategy",
              ty: { Plaintext: { Primitive: "Identifier" } },
              mode: "Private" as const,
            },
            {
              name: "maybe_strategy",
              ty: { Plaintext: { Optional: { Primitive: "Identifier" } } },
              mode: "Private" as const,
            },
            {
              name: "strategies",
              ty: { Plaintext: { Array: [{ Primitive: "Identifier" }, 2] } },
              mode: "Private" as const,
            },
            { name: "vote", ty: { Record: rref("Vote") }, mode: "Private" as const },
          ],
          outputs: [{ ty: { Plaintext: { Primitive: "Identifier" } }, mode: "Private" as const }],
        },
      ],
    };

    const output = generateBindings(abi);
    expect(output).toContain("readonly strategy: IdentifierInput");
    expect(output).toContain("readonly maybe_strategy: IdentifierInput | null");
    expect(output).toContain("readonly strategies: ReadonlyArray<IdentifierInput>");
    expect(output).toContain(
      'BaseContract.serializeIdentifier(args.strategy, this.inputContext("route", "strategy"))',
    );
    expect(output).toContain(
      'BaseContract.serializeIdentifier(value.strategy, BaseContract.childInputContext(context, "strategy"))',
    );
    expect(output).toContain("BaseContract.serializeIdentifier(e, context)");
    expect(output).toContain("{ is_some: false, val: 'lionden_zero' }");
    expect(output).toContain('BaseContract.parseIdentifier(this.outputAt(_result, "route", 0))');
    expect(output).toContain("selectedStrategy: {");
    expect(output).toContain("get: async (key: IdentifierInput): Promise<LeoIdentifier> =>");
    expect(output).toContain(
      "tryGet: async (key: IdentifierInput): Promise<LeoIdentifier | null> =>",
    );
    expect(output).toContain(
      'this.queryMapping("selected_strategy", BaseContract.serializeIdentifier(key, { programId: this.programId, input: "selected_strategy key" }))',
    );
    expect(output).toContain("BaseContract.parseIdentifier(_result)");
    expectGeneratedToTypecheck("Governance", output);
  });

  it("serializes array inputs using map", () => {
    const abi: ProgramABI = {
      program: "test.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "sum",
          is_async: false,
          inputs: [
            {
              name: "values",
              ty: { Plaintext: { Array: [{ Primitive: { UInt: "U32" } }, 4] } },
              mode: "Private" as const,
            },
          ],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode: "Private" as const },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("BaseContract.serializeArray(args.values");
    expect(output).toContain("BaseContract.serializeUInt(e, 32, context)");
  });
});

describe("deserialization of output types", () => {
  it("deserializes Boolean output", () => {
    const abi: ProgramABI = {
      program: "test.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "check",
          is_async: false,
          inputs: [],
          outputs: [
            { ty: { Plaintext: { Primitive: "Boolean" as const } }, mode: "Private" as const },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("): Promise<boolean>");
    expect(output).toContain('BaseContract.parseBoolean(this.outputAt(_result, "check", 0))');
  });

  it("deserializes number output (U32)", () => {
    const abi: ProgramABI = {
      program: "test.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "count",
          is_async: false,
          inputs: [],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode: "Private" as const },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("): Promise<number>");
    expect(output).toContain('BaseContract.parseNumber(this.outputAt(_result, "count", 0))');
  });

  it("deserializes string output (Address)", () => {
    const abi: ProgramABI = {
      program: "test.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "owner",
          is_async: false,
          inputs: [],
          outputs: [
            { ty: { Plaintext: { Primitive: "Address" as const } }, mode: "Private" as const },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("): Promise<LeoAddress>");
    expect(output).toContain('BaseContract.parseAddress(this.outputAt(_result, "owner", 0))');
  });

  it("deserializes Field/Group/Scalar as string", () => {
    for (const prim of ["Field", "Group", "Scalar"] as const) {
      const abi: ProgramABI = {
        program: "test.aleo",
        structs: [],
        records: [],
        mappings: [],
        storage_variables: [],
        transitions: [
          {
            name: "get_val",
            is_async: false,
            inputs: [],
            outputs: [{ ty: { Plaintext: { Primitive: prim } }, mode: "Private" as const }],
          },
        ],
      };
      const output = generateBindings(abi);
      expect(output).toContain(`): Promise<Leo${prim}>`);
      expect(output).toContain(`BaseContract.parse${prim}(this.outputAt(_result, "get_val", 0))`);
    }
  });
});

describe("program ID to class name", () => {
  it("converts hello_world.aleo to HelloWorld", () => {
    const abi: ProgramABI = {
      program: "hello_world.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export class HelloWorld extends BaseContract");
  });

  it("converts dashed-name.aleo to DashedName", () => {
    const abi: ProgramABI = {
      program: "dashed-name.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export class DashedName extends BaseContract");
  });
});

describe("generated TypeScript validity", () => {
  it("typechecks generated bindings for mixed ABI features", () => {
    const abi: ProgramABI = {
      program: "check.aleo",
      structs: [
        {
          path: ["Inner"],
          fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }],
        },
        {
          path: ["Settings"],
          fields: [
            { name: "backup", ty: { Optional: { Struct: sref("Inner") } } },
            { name: "remote", ty: { Struct: { path: ["Info"], program: "registry.aleo" } } },
          ],
        },
      ],
      records: [
        {
          path: ["Coin"],
          fields: [
            { name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const },
            { name: "value", ty: { Primitive: { UInt: "U64" } }, mode: "Private" as const },
          ],
        },
      ],
      mappings: [
        {
          name: "entries",
          key: { Primitive: "Field" as const },
          value: { Struct: sref("Settings") },
        },
      ],
      storage_variables: [
        { name: "admin", ty: { Plaintext: { Primitive: "Address" } } },
        { name: "watchers", ty: { Vector: { Plaintext: { Primitive: "Address" } } } },
      ],
      transitions: [
        {
          name: "mint_and_finalize",
          is_async: true,
          inputs: [
            {
              name: "receiver",
              ty: { Plaintext: { Primitive: "Address" } },
              mode: "Public" as const,
            },
            { name: "record", ty: { Record: rref("Coin") }, mode: "Private" as const },
            {
              name: "externalInfo",
              ty: { Plaintext: { Struct: { path: ["Info"], program: "registry.aleo" } } },
              mode: "Private" as const,
            },
          ],
          outputs: [
            { ty: { Record: rref("Coin") }, mode: "Private" as const },
            { ty: { Future: "check.aleo" }, mode: "Private" as const },
          ],
        },
      ],
    };

    const output = generateBindings(abi);
    expectGeneratedToTypecheck("Check", output);
  });
});

describe("interface conversion helper emission", () => {
  const TOKEN_ABI: ProgramABI = {
    program: "stable_token.aleo",
    structs: [],
    records: [
      {
        path: ["Token"],
        fields: [
          { name: "amount", ty: { Primitive: { UInt: "U128" } }, mode: "Private" },
          { name: "_version", ty: { Primitive: { UInt: "U8" } }, mode: "Private" },
        ],
      },
    ],
    mappings: [],
    storage_variables: [],
    transitions: [],
  };

  it("emits asXxx free function above the contract class", () => {
    const output = generateBindings(TOKEN_ABI, [TOKEN_ABI], {
      dynamicRecords: [
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
      ],
    });
    // Helper is emitted as a callable+namespace: an internal `_asPoolTokenImpl`
    // does the actual `Leo.dynamicRecord(...)` conversion, then `Object.assign`
    // attaches `.output` (a RecordOutputMatcher) so callers can feed it to
    // `.match(matcher.from(...))` or `.match(matcher.at(...))`.
    expect(output).toContain("function _asPoolTokenImpl(value: TokenInput): LeoDynamicRecord");
    expect(output).toContain("export const asPoolToken = Object.assign(_asPoolTokenImpl, {");
    expect(output).toContain("output: createRecordOutputMatcher<Token>({");
    expect(output).toContain('program: "stable_token.aleo"');
    expect(output).toContain('recordName: "Token"');
    expect(output).toContain("deserialize: deserializeToken");
    expect(output).toContain("Leo.dynamicRecord(value, {");
    expect(output).toContain('"address.private"');
    expect(output).toContain('"u8.public"');
    expect(output).toContain('"group.public"');
    // `Leo` and `createRecordOutputMatcher` are value-imports on this program
    // (helpers emitted); the matcher type is a type-only import.
    expect(output).toMatch(
      /import \{ BaseContract, Leo, createRecordOutputMatcher, .*type RecordOutputMatcher/,
    );
  });

  it("does not import Leo as a value when no helpers are configured", () => {
    const output = generateBindings(TOKEN_ABI);
    expect(output).not.toContain("import { BaseContract, Leo,");
    // Value imports always include `createRecordOutputMatcher` for the
    // record-output matcher API; `Leo` is value-imported only when a
    // dynamic-record helper is emitted in this module.
    expect(output).toContain("import { BaseContract, createRecordOutputMatcher,");
  });

  it("throws CodegenError when schema is missing a field", () => {
    expect(() =>
      generateBindings(TOKEN_ABI, [TOKEN_ABI], {
        dynamicRecords: [
          {
            helperName: "asPoolToken",
            sourceRecord: "Token",
            sourceProgram: "stable_token.aleo",
            schema: {
              owner: "address.private",
              amount: "u128.private",
              _nonce: "group.public",
            },
          },
        ],
      }),
    ).toThrow(/schema keys do not match.+Missing: \[_version\]/);
  });

  it("throws CodegenError when schema has an extra field", () => {
    expect(() =>
      generateBindings(TOKEN_ABI, [TOKEN_ABI], {
        dynamicRecords: [
          {
            helperName: "asPoolToken",
            sourceRecord: "Token",
            sourceProgram: "stable_token.aleo",
            schema: {
              owner: "address.private",
              amount: "u128.private",
              _version: "u8.public",
              _nonce: "group.public",
              ghost: "field.private",
            },
          },
        ],
      }),
    ).toThrow(/Extra: \[ghost\]/);
  });

  it("throws CodegenError when a schema primitive doesn't match the record field", () => {
    expect(() =>
      generateBindings(TOKEN_ABI, [TOKEN_ABI], {
        dynamicRecords: [
          {
            helperName: "asPoolToken",
            sourceRecord: "Token",
            sourceProgram: "stable_token.aleo",
            schema: {
              owner: "address.private",
              amount: "field.private",
              _version: "u8.public",
              _nonce: "group.public",
            },
          },
        ],
      }),
    ).toThrow(/schema\.amount: field has Leo type 'u128'.+schema says 'field'/);
  });

  it("rejects non-primitive record fields", () => {
    const abi: ProgramABI = {
      ...TOKEN_ABI,
      records: [
        {
          path: ["Token"],
          fields: [
            { name: "data", ty: { Array: [{ Primitive: { UInt: "U8" } }, 4] }, mode: "Private" },
          ],
        },
      ],
    };
    expect(() =>
      generateBindings(abi, [abi], {
        dynamicRecords: [
          {
            helperName: "asPoolToken",
            sourceRecord: "Token",
            sourceProgram: "stable_token.aleo",
            schema: { owner: "address.private", data: "u8.private", _nonce: "group.public" },
          },
        ],
      }),
    ).toThrow(/non-primitive field 'data'/);
  });

  it("rejects unsupported primitives like Identifier", () => {
    const abi: ProgramABI = {
      ...TOKEN_ABI,
      records: [
        {
          path: ["Token"],
          fields: [{ name: "id", ty: { Primitive: "Identifier" }, mode: "Private" }],
        },
      ],
    };
    expect(() =>
      generateBindings(abi, [abi], {
        dynamicRecords: [
          {
            helperName: "asPoolToken",
            sourceRecord: "Token",
            sourceProgram: "stable_token.aleo",
            schema: { owner: "address.private", id: "identifier.private", _nonce: "group.public" },
          },
        ],
      }),
    ).toThrow(/unsupported primitive 'identifier'/);
  });

  it("throws CodegenError when sourceRecord is not a local record", () => {
    expect(() =>
      generateBindings(TOKEN_ABI, [TOKEN_ABI], {
        dynamicRecords: [
          {
            helperName: "asPoolToken",
            sourceRecord: "Mystery",
            sourceProgram: "stable_token.aleo",
            schema: { owner: "address.private", _nonce: "group.public" },
          },
        ],
      }),
    ).toThrow(/sourceRecord 'Mystery' is not a local record/);
  });
});

describe("typed-output projector Future index contract", () => {
  /**
   * Critical invariant: rawOutputs keeps the ORIGINAL ABI output position
   * (Futures occupy their slot). Typed `outputs` drops Future entries from
   * the result shape but each non-Future output must still wrap rawOutputs
   * at its *original* ABI index — never a compacted index.
   */
  function abiWithOutputs(outputs: readonly { ty: any }[]): ProgramABI {
    return {
      program: "future_demo.aleo",
      structs: [],
      records: [
        {
          path: ["Token"],
          fields: [{ name: "amount", ty: { Primitive: { UInt: "U128" } }, mode: "Private" }],
        },
      ],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "demo",
          is_async: true,
          inputs: [],
          outputs: outputs.map((o) => ({ ty: o.ty, mode: "Private" as const })),
        },
      ],
    };
  }

  it("[Future, Token] wraps rawOutputs[1], not [0]", () => {
    const abi = abiWithOutputs([
      { ty: { Future: "demo.aleo" } },
      { ty: { Record: rref("Token") } },
    ]);
    const output = generateBindings(abi);
    // Single non-Future output → projector returns a bare value (no tuple).
    expect(output).toContain('BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 1)');
    expect(output).not.toContain(
      'BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 0)',
    );
    expect(output).toContain("Promise<AcceptedTransition<EncryptedRecord<Token>>>");
  });

  it("[Token, Future, u128] wraps rawOutputs[0] and rawOutputs[2], skipping index 1", () => {
    // u128 is mode: "Private" (default-private) in abiWithOutputs, so it becomes
    // EncryptedValue<bigint> rather than bare bigint.
    const abi = abiWithOutputs([
      { ty: { Record: rref("Token") } },
      { ty: { Future: "demo.aleo" } },
      { ty: { Plaintext: { Primitive: { UInt: "U128" } } } },
    ]);
    const output = generateBindings(abi);
    expect(output).toContain('BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 0)');
    expect(output).toContain('BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 2)');
    expect(output).not.toContain(
      'BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 1)',
    );
    expect(output).toContain(
      "Promise<AcceptedTransition<[EncryptedRecord<Token>, EncryptedValue<bigint>]>>",
    );
  });

  it("all-Future outputs project to AcceptedTransition<void>", () => {
    const abi = abiWithOutputs([{ ty: { Future: "demo.aleo" } }]);
    const output = generateBindings(abi);
    expect(output).toContain("Promise<AcceptedTransition<void>>");
    expect(output).toContain(
      "(_rawOutputs: readonly RawTransitionOutput[], _tpk: string, _transitions: readonly ConfirmedTransitionRecord[]) => undefined as void",
    );
    expect(output).not.toContain('BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo"');
  });
});

describe("mode-gated plaintext output emission", () => {
  /**
   * Public plaintext outputs come back as Leo literals on chain → eager
   * decode. Private/None plaintext outputs come back as value ciphertexts
   * (`ciphertext1...`) → wrap as `EncryptedValue<T>` so the caller can
   * decrypt with a view key.
   */
  function abiOneOutput(
    mode: "Private" | "Public" | "Constant",
    inputs: readonly { name: string; mode: "Private" | "Public" }[] = [],
  ): ProgramABI {
    return {
      program: "mode_demo.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "demo",
          is_async: false,
          inputs: inputs.map((i) => ({
            name: i.name,
            ty: { Plaintext: { Primitive: { UInt: "U64" } } },
            mode: i.mode,
          })),
          outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode }],
        },
      ],
    };
  }

  it("public plaintext output is eagerly decoded (no EncryptedValue handle)", () => {
    const out = generateBindings(abiOneOutput("Public"));
    expect(out).toContain("Promise<AcceptedTransition<bigint>>");
    expect(out).toContain(
      'BaseContract.parseBigInt(BaseContract.rawOutputAt(rawOutputs, "mode_demo.aleo", "demo", 0))',
    );
    // EncryptedValue may appear in the import list, but never as a generic
    // type instantiation in this public-only program.
    expect(out).not.toContain("EncryptedValue<");
    expect(out).not.toContain("makeEncryptedValue");
    // Projector uses _tpk since no private plaintext consumer.
    expect(out).toContain("_tpk: string");
  });

  it("private plaintext output wraps as EncryptedValue<T>", () => {
    const out = generateBindings(abiOneOutput("Private"));
    expect(out).toContain("Promise<AcceptedTransition<EncryptedValue<bigint>>>");
    expect(out).toContain(
      'BaseContract.makeEncryptedValue(BaseContract.rawOutputAt(rawOutputs, "mode_demo.aleo", "demo", 0), tpk, "mode_demo.aleo", "demo", 0, BaseContract.parseBigInt)',
    );
    // Projector binds `tpk` (no underscore) since at least one private plaintext.
    expect(out).toMatch(
      /\(rawOutputs: readonly RawTransitionOutput\[\], tpk: string, _transitions: readonly ConfirmedTransitionRecord\[\]\) =>/,
    );
  });

  it('"Constant" mode is non-Public, so it also wraps as EncryptedValue<T>', () => {
    const out = generateBindings(abiOneOutput("Constant"));
    expect(out).toContain("Promise<AcceptedTransition<EncryptedValue<bigint>>>");
    expect(out).toContain("BaseContract.makeEncryptedValue");
  });

  it("globalIndex = inputs.length + abiIndex for private plaintext outputs", () => {
    // 2 inputs + 1 private u64 output → output@abiIndex=0 → globalIndex=2.
    const out = generateBindings(
      abiOneOutput("Private", [
        { name: "a", mode: "Public" },
        { name: "b", mode: "Public" },
      ]),
    );
    expect(out).toContain('"mode_demo.aleo", "demo", 2, BaseContract.parseBigInt');
  });

  it("globalIndex for multi-output mix: public output + private output", () => {
    // 1 input + [u64.public, u64.private] → public@0, private@1; globalIndex
    // for private output is inputs.length(1) + abiIndex(1) = 2.
    const abi: ProgramABI = {
      program: "mixed_mode.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "demo",
          is_async: false,
          inputs: [
            { name: "x", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" },
          ],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" },
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Private" },
          ],
        },
      ],
    };
    const out = generateBindings(abi);
    expect(out).toContain("Promise<AcceptedTransition<[bigint, EncryptedValue<bigint>]>>");
    // Public@abi0 → eager parse on rawOutputs[0].
    expect(out).toContain(
      'BaseContract.parseBigInt(BaseContract.rawOutputAt(rawOutputs, "mixed_mode.aleo", "demo", 0))',
    );
    // Private@abi1 → makeEncryptedValue on rawOutputs[1] with globalIndex 1 + 1 = 2.
    expect(out).toContain(
      'BaseContract.makeEncryptedValue(BaseContract.rawOutputAt(rawOutputs, "mixed_mode.aleo", "demo", 1), tpk, "mixed_mode.aleo", "demo", 2, BaseContract.parseBigInt)',
    );
  });
});

describe("assertTypechainModuleNamesUnique", () => {
  it("accepts program ids that map to distinct module file names", () => {
    // FooBar / Widget / Baz — distinct even when lower-cased.
    expect(() =>
      assertTypechainModuleNamesUnique(["foo_bar.aleo", "widget.aleo", "baz.aleo"]),
    ).not.toThrow();
  });

  it("rejects two program ids that collapse to the same class name (overwrite)", () => {
    // `foo_bar.aleo` and `foo__bar.aleo` both → `FooBar` → `FooBar.ts`, so the
    // second write would silently overwrite the first.
    let caught: unknown;
    try {
      assertTypechainModuleNamesUnique(["foo_bar.aleo", "foo__bar.aleo"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodegenError);
    expect((caught as CodegenError).message).toContain("FooBar.ts");
    expect((caught as CodegenError).message).toContain("foo_bar.aleo");
    expect((caught as CodegenError).message).toContain("foo__bar.aleo");
    expect((caught as CodegenError).context).toMatchObject({
      fileStem: "FooBar",
      conflictsWith: "foo_bar.aleo",
    });
  });

  it("also catches trailing-underscore ids that collapse together", () => {
    expect(() => assertTypechainModuleNamesUnique(["foobar.aleo", "foobar_.aleo"])).toThrow(
      CodegenError,
    );
  });

  it("rejects a program id colliding with the reserved BaseContract file", () => {
    // `base_contract.aleo` → `BaseContract` → would overwrite the runtime
    // `BaseContract.ts` written by the emitter.
    let caught: unknown;
    try {
      assertTypechainModuleNamesUnique(["base_contract.aleo"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodegenError);
    expect((caught as CodegenError).message).toContain("BaseContract.ts");
    expect((caught as CodegenError).message).toContain("reserved");
  });

  it("rejects a program id colliding with the reserved index file (case-insensitive)", () => {
    // `index.aleo` → `Index` → `Index.ts`, which on a case-insensitive FS
    // (macOS/Windows) overwrites the barrel `index.ts`.
    expect(() => assertTypechainModuleNamesUnique(["index.aleo"])).toThrow(CodegenError);
  });

  it("rejects two program ids whose class names differ only by case", () => {
    // `ab.aleo` → `Ab`, `a_b.aleo` → `AB`: distinct on Linux, same file on
    // macOS/Windows.
    expect(() => assertTypechainModuleNamesUnique(["ab.aleo", "a_b.aleo"])).toThrow(CodegenError);
  });

  it("does not over-reserve unrelated names (record_output_matcher is fine)", () => {
    // Only `BaseContract`/`index` file stems are reserved; a program whose class
    // name is `RecordOutputMatcher` gets its own distinct module file.
    expect(() => assertTypechainModuleNamesUnique(["record_output_matcher.aleo"])).not.toThrow();
  });
});

describe("reserved-name guards", () => {
  const baseAbi = (over: Partial<ProgramABI>): ProgramABI => ({
    program: "p.aleo",
    structs: [],
    records: [],
    mappings: [],
    storage_variables: [],
    transitions: [],
    ...over,
  });
  const u32Plaintext = { Plaintext: { Primitive: { UInt: "U32" } } } as const;
  const u32Transition = (name: string): ProgramABI["transitions"][number] => ({
    name,
    is_async: false,
    inputs: [{ name: "a", ty: u32Plaintext, mode: "Public" }],
    outputs: [{ ty: u32Plaintext, mode: "Public" }],
  });

  it("rejects a local struct named like a fixed BaseContract import (LeoField)", () => {
    const abi = baseAbi({
      program: "leo_field_holder.aleo",
      structs: [
        { path: ["LeoField"], fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }] },
      ],
    });
    expect(() => generateBindings(abi)).toThrow(CodegenError);
    expect(() => generateBindings(abi)).toThrow(/LeoField/);
  });

  it("rejects a local struct named BaseContract", () => {
    const abi = baseAbi({
      structs: [
        { path: ["BaseContract"], fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }] },
      ],
    });
    expect(() => generateBindings(abi)).toThrow(CodegenError);
  });

  it("rejects a local type named like the emitted storage interface", () => {
    const abi = baseAbi({
      program: "vault.aleo",
      structs: [
        { path: ["VaultStorage"], fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }] },
      ],
      storage_variables: [{ name: "admin", ty: { Plaintext: { Primitive: "Address" } } }],
    });

    expect(() => generateBindings(abi)).toThrow(CodegenError);
    expect(() => generateBindings(abi)).toThrow(/VaultStorage/);
  });

  it("allows a local type named like the storage interface when no storage is emitted", () => {
    const abi = baseAbi({
      program: "vault.aleo",
      structs: [
        { path: ["VaultStorage"], fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }] },
      ],
    });

    expect(() => generateBindings(abi)).not.toThrow();
  });

  it("allows a local record named Leo when no dynamic-record helpers import Leo", () => {
    const abi = baseAbi({
      program: "value_named_record.aleo",
      records: [
        {
          path: ["Leo"],
          fields: [{ name: "owner", ty: { Primitive: "Address" }, mode: "Private" }],
        },
      ],
    });
    const out = generateBindings(abi);
    expect(out).not.toContain("import { BaseContract, Leo,");
    expect(out).toContain("export interface Leo");
    expectGeneratedToTypecheck("ValueNamedRecord", out);
  });

  it("allows local types matching value-only imports when helpers import Leo", () => {
    const abi = baseAbi({
      program: "value_named_helpers.aleo",
      structs: [
        {
          path: ["createRecordOutputMatcher"],
          fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }],
        },
      ],
      records: [
        {
          path: ["Leo"],
          fields: [{ name: "owner", ty: { Primitive: "Address" }, mode: "Private" }],
        },
      ],
    });
    const out = generateBindings(abi, [abi], {
      dynamicRecords: [
        {
          helperName: "asLeo",
          sourceProgram: "value_named_helpers.aleo",
          sourceRecord: "Leo",
          schema: { owner: "address.private", _nonce: "group.public" },
        },
      ],
    });
    expect(out).toContain("import { BaseContract, Leo, createRecordOutputMatcher,");
    expect(out).toContain("export interface createRecordOutputMatcher");
    expect(out).toContain("export interface Leo");
    expect(out).toContain("return Leo.dynamicRecord(value, {");
    expectGeneratedToTypecheck("ValueNamedHelpers", out);
  });

  it("auto-renames a class colliding with a fixed import (record_output_matcher.aleo)", () => {
    const abi = baseAbi({
      program: "record_output_matcher.aleo",
      transitions: [u32Transition("identity")],
    });
    const out = generateBindings(abi);
    // The class + factory are suffixed away from the imported names, so the
    // generated module typechecks.
    expect(out).toContain("export class RecordOutputMatcherContract extends BaseContract");
    expect(out).toContain("export function createRecordOutputMatcherContract(");
    expectGeneratedToTypecheck("RecordOutputMatcher", out);
  });

  it("preserves Leo/createLeo for leo.aleo when helpers do not import Leo", () => {
    const abi = baseAbi({
      program: "leo.aleo",
      transitions: [u32Transition("identity")],
    });

    const out = generateBindings(abi);
    expect(out).not.toContain("import { BaseContract, Leo,");
    expect(out).toContain("export class Leo extends BaseContract");
    expect(out).toContain("export function createLeo(");
    expect(out).not.toContain("export class LeoContract");
    expect(out).not.toContain("export function createLeoContract(");
    expectGeneratedToTypecheck("Leo", out);
  });

  it("auto-renames leo.aleo class only when helpers import Leo", () => {
    const abi = baseAbi({
      program: "leo.aleo",
      records: [
        {
          path: ["Token"],
          fields: [{ name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "Private" }],
        },
      ],
    });

    const out = generateBindings(abi, [abi], {
      dynamicRecords: [
        {
          helperName: "asToken",
          sourceProgram: "leo.aleo",
          sourceRecord: "Token",
          schema: {
            owner: "address.private",
            amount: "u64.private",
            _nonce: "group.public",
          },
        },
      ],
    });

    expect(out).toContain("import { BaseContract, Leo, createRecordOutputMatcher,");
    expect(out).toContain("export class LeoContract extends BaseContract");
    expect(out).toContain("export function createLeoContract(");
    expect(out).not.toContain("export class Leo extends BaseContract");
    expectGeneratedToTypecheck("Leo", out);
  });

  it("rejects transitions colliding with inherited members", () => {
    for (const name of ["connect", "withSigner", "programId", "address", "executeLocal"]) {
      const abi = baseAbi({ transitions: [u32Transition(name)] });
      expect(() => generateBindings(abi), name).toThrow(CodegenError);
    }
  });

  it("rejects a transition named `mappings` when the program has mappings", () => {
    const abi = baseAbi({
      mappings: [
        { name: "counts", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } },
      ],
      transitions: [u32Transition("mappings")],
    });
    expect(() => generateBindings(abi)).toThrow(/mappings/);
  });

  it("allows a transition named `mappings` when the program has no mappings", () => {
    const abi = baseAbi({ transitions: [u32Transition("mappings")] });
    expect(() => generateBindings(abi)).not.toThrow();
  });

  it("does not reject ordinary type or transition names", () => {
    const abi = baseAbi({
      structs: [{ path: ["Note"], fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }] }],
      transitions: [u32Transition("transfer")],
    });
    expect(() => generateBindings(abi)).not.toThrow();
  });

  it("reserved member list stays in sync with BaseContract instance members", () => {
    // Derive the actual instance-member set from the emitted BaseContract class by
    // walking its AST. If a member is added/removed without updating the reserved
    // list (a silent collision regression), the matching transition stops throwing
    // and this test fails. Parsing the AST (rather than the source text) keeps the
    // extractor immune to brace/indentation quirks in generated method bodies.
    const source = generateBaseContract();
    const sourceFile = ts.createSourceFile(
      "BaseContract.ts",
      source,
      ts.ScriptTarget.ES2024,
      /* setParentNodes */ true,
    );

    let classDecl: ts.ClassDeclaration | undefined;
    sourceFile.forEachChild((node) => {
      if (ts.isClassDeclaration(node) && node.name?.text === "BaseContract") {
        classDecl = node;
      }
    });
    expect(classDecl, "BaseContract class declaration not found").toBeDefined();

    const members = new Set<string>();
    for (const member of (classDecl as ts.ClassDeclaration).members) {
      // The generated subclass always emits its own `constructor(options?)`, so a
      // transition named `constructor` would redeclare it (and `readonly
      // constructor = …` is itself a class-field syntax error). A
      // ConstructorDeclaration has no `member.name`, so capture it explicitly
      // rather than dropping it at the `name === undefined` check below.
      if (ts.isConstructorDeclaration(member)) {
        members.add("constructor");
        continue;
      }
      // Statics don't collide with instance accessors; index signatures and
      // static blocks have no colliding name.
      const isStatic = (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0;
      if (isStatic) continue;
      const name = member.name;
      if (name === undefined) continue;
      // `#private` fields are ECMAScript-private — never inherited, so they can't
      // collide with a generated subclass accessor. Soft-`private` keyword members
      // do collide and carry a plain identifier/string name.
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        members.add(name.text);
      }
    }

    // Guard against a broken extractor silently asserting nothing.
    expect(members.size).toBeGreaterThan(20);

    for (const member of members) {
      const abi = baseAbi({ transitions: [u32Transition(member)] });
      expect(() => generateBindings(abi), member).toThrow(CodegenError);
    }
  });

  // A dynamic-record helper emits `export const ${helperName}`. When that name
  // equals another module-level value binding — the contract class, its
  // `create${class}` factory, a fixed BaseContract value import (`Leo` etc.), or
  // a per-type serialize/deserialize/decrypt const — the module would declare
  // the same identifier twice (TS2451/TS2440). Those bindings either can't be
  // renamed (fixed imports) or are the public call API (class/factory), so the
  // helper (user config) is rejected rather than silently bumped.
  // `consumer.aleo` → class `Consumer`, factory `createConsumer`.
  const consumerAbi = baseAbi({
    program: "consumer.aleo",
    records: [
      {
        path: ["Receipt"],
        fields: [{ name: "owner", ty: { Primitive: "Address" }, mode: "Private" }],
      },
    ],
  });
  const helperConfig = (helperName: string) => ({
    dynamicRecords: [
      {
        helperName,
        sourceProgram: "consumer.aleo",
        sourceRecord: "Receipt",
        schema: { owner: "address.private", _nonce: "group.private" },
      },
    ],
  });

  it("rejects a dynamic-record helper named like the contract class", () => {
    // A helper `Consumer` would emit a second `export const Consumer`.
    expect(() => generateBindings(consumerAbi, [consumerAbi], helperConfig("Consumer"))).toThrow(
      CodegenError,
    );
    expect(() => generateBindings(consumerAbi, [consumerAbi], helperConfig("Consumer"))).toThrow(
      /Consumer/,
    );
  });

  it("rejects a dynamic-record helper named like the create-factory", () => {
    // A helper `createConsumer` would emit a second `export const createConsumer`.
    let caught: unknown;
    try {
      generateBindings(consumerAbi, [consumerAbi], helperConfig("createConsumer"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodegenError);
    expect((caught as CodegenError).message).toContain("createConsumer");
    expect((caught as CodegenError).context).toMatchObject({ helperName: "createConsumer" });
  });

  it("rejects a dynamic-record helper named like a fixed BaseContract value import", () => {
    // Any helper-emitting module value-imports `Leo`; a helper `Leo` would emit a
    // second `export const Leo`. `BaseContract`/`createRecordOutputMatcher` are
    // always imported.
    for (const name of ["Leo", "BaseContract", "createRecordOutputMatcher"]) {
      expect(() => generateBindings(consumerAbi, [consumerAbi], helperConfig(name)), name).toThrow(
        CodegenError,
      );
    }
  });

  it("rejects a dynamic-record helper named like a generated serialize/decrypt const", () => {
    // `consumer.aleo` declares record `Receipt`, emitting `serializeReceipt` /
    // `deserializeReceipt` / `decryptReceipt` value consts.
    for (const name of ["serializeReceipt", "deserializeReceipt", "decryptReceipt"]) {
      expect(() => generateBindings(consumerAbi, [consumerAbi], helperConfig(name)), name).toThrow(
        CodegenError,
      );
    }
  });

  it("allows a dynamic-record helper named like an external struct type-only alias", () => {
    const registryAbi = baseAbi({
      program: "registry.aleo",
      structs: [
        {
          path: ["TokenInfo"],
          fields: [{ name: "amount", ty: { Primitive: { UInt: "U64" } } }],
        },
      ],
    });
    const consumerWithExternalStruct = baseAbi({
      program: "consumer.aleo",
      records: consumerAbi.records,
      transitions: [
        {
          name: "submit",
          is_async: false,
          inputs: [
            {
              name: "info",
              ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } } },
              mode: "Private",
            },
          ],
          outputs: [],
        },
      ],
    });
    const options = helperConfig("Registry_TokenInfo");

    expect(() =>
      generateBindings(
        consumerWithExternalStruct,
        [registryAbi, consumerWithExternalStruct],
        options,
      ),
    ).not.toThrow();

    const registryOut = generateBindings(registryAbi, [registryAbi, consumerWithExternalStruct]);
    const consumerOut = generateBindings(
      consumerWithExternalStruct,
      [registryAbi, consumerWithExternalStruct],
      options,
    );
    expectGeneratedModulesToTypecheck({ Registry: registryOut, Consumer: consumerOut });
  });

  it("rejects a dynamic-record helper named like an external record value binding", () => {
    const registryAbi = baseAbi({
      program: "registry.aleo",
      records: [
        {
          path: ["Token"],
          fields: [{ name: "owner", ty: { Primitive: "Address" }, mode: "Private" }],
        },
      ],
    });
    const consumerWithExternalRecord = baseAbi({
      program: "consumer.aleo",
      records: consumerAbi.records,
      transitions: [
        {
          name: "submit",
          is_async: false,
          inputs: [
            { name: "token", ty: { Record: rref("Token", "registry.aleo") }, mode: "Private" },
          ],
          outputs: [],
        },
      ],
    });

    expect(() =>
      generateBindings(
        consumerWithExternalRecord,
        [registryAbi, consumerWithExternalRecord],
        helperConfig("Registry_Token"),
      ),
    ).toThrow(CodegenError);
  });

  it("rejects a dynamic-record helper named like another helper's backing impl function", () => {
    // Helper `asReceipt` emits `function _asReceiptImpl`; a second helper literally
    // named `_asReceiptImpl` would emit `export const _asReceiptImpl` → duplicate.
    const twoHelpers = {
      dynamicRecords: [
        {
          helperName: "asReceipt",
          sourceProgram: "consumer.aleo",
          sourceRecord: "Receipt",
          schema: { owner: "address.private", _nonce: "group.private" },
        },
        {
          helperName: "_asReceiptImpl",
          sourceProgram: "consumer.aleo",
          sourceRecord: "Receipt",
          schema: { owner: "address.private", _nonce: "group.private" },
        },
      ],
    };
    let caught: unknown;
    try {
      generateBindings(consumerAbi, [consumerAbi], twoHelpers);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodegenError);
    expect((caught as CodegenError).message).toContain("_asReceiptImpl");
    expect((caught as CodegenError).message).toContain("asReceipt");
    expect((caught as CodegenError).context).toMatchObject({ helperName: "_asReceiptImpl" });
  });

  it("allows two helpers whose names don't collide with each other's impl", () => {
    const twoHelpers = {
      dynamicRecords: ["asReceipt", "asReceiptToo"].map((helperName) => ({
        helperName,
        sourceProgram: "consumer.aleo",
        sourceRecord: "Receipt",
        schema: { owner: "address.private", _nonce: "group.private" },
      })),
    };
    expect(() => generateBindings(consumerAbi, [consumerAbi], twoHelpers)).not.toThrow();
  });

  it("allows a dynamic-record helper whose name differs from every emitted binding", () => {
    expect(() =>
      generateBindings(consumerAbi, [consumerAbi], helperConfig("asReceipt")),
    ).not.toThrow();
  });
});
