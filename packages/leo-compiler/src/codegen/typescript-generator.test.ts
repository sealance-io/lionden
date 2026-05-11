import { describe, it, expect } from "vitest";
import ts from "typescript";
import { generateBindings, generateBaseContract } from "./typescript-generator.js";
import type { ProgramABI, StructRef, RecordRef } from "../abi-types.js";

/** Shorthand for creating a StructRef in tests */
function sref(name: string, program: string | null = null): StructRef {
  return { path: [name], program };
}

/** Shorthand for creating a RecordRef in tests */
function rref(name: string, program: string | null = null): RecordRef {
  return { path: [name], program };
}

function expectGeneratedToTypecheck(programName: string, output: string): void {
  const files: Record<string, string> = {
    "/virtual/package.json": '{ "type": "module" }',
    "/virtual/BaseContract.ts": generateBaseContract(),
    [`/virtual/${programName}.ts`]: output,
    "/virtual/core.d.ts": "export interface LionDenRuntimeEnvironment { network: unknown }",
    "/virtual/network.d.ts": [
      "export declare function decryptRecordCiphertext(ciphertext: string, viewKey: string, options?: { readonly network?: \"testnet\" | \"mainnet\" }): Promise<string>;",
      "export declare function deriveViewKey(privateKey: string, options?: { readonly network?: \"testnet\" | \"mainnet\" }): Promise<string>;",
      "export declare class NetworkRecordDecryptionError extends Error {",
      "  readonly kind: \"NetworkRecordDecryptionError\";",
      "  readonly ciphertextPrefix: string;",
      "  constructor(message: string, ciphertextPrefix: string, cause?: unknown);",
      "}",
    ].join("\n"),
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
        { name: "receiver", ty: { Plaintext: { Primitive: "Address" as const } }, mode: "None" as const },
        { name: "amount", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" as const },
      ],
      outputs: [
        { ty: { Record: rref("Token") }, mode: "None" as const },
      ],
    },
    {
      name: "transfer",
      is_async: false,
      inputs: [
        { name: "receiver", ty: { Plaintext: { Primitive: "Address" as const } }, mode: "None" as const },
        { name: "amount", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" as const },
      ],
      outputs: [],
    },
  ],
};

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
    expect(output).toContain("export function serializeToken(value: Token, context?: TransitionInputContext): string");
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
          inputs: [
            { name: "coin", ty: { Record: rref("Coin") }, mode: "None" as const },
          ],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abi);
    // The transition method should serialize via serializeCoin(), not JSON.stringify
    expect(output).toContain('serializeCoin(args.coin as Coin, this.inputContext("spend", "coin"))');
    expect(output).not.toContain("JSON.stringify");
  });

  it("generates contract class extending BaseContract", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export class TokenContract extends BaseContract");
    expect(output).toContain('super("token.aleo")');
  });

  it("generates typed transition methods", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("readonly mint = {");
    expect(output).toContain("locally: async (args: { readonly receiver: AddressInput; readonly amount: bigint }, options?: LocalExecutionOptions): Promise<Token>");
    expect(output).toContain("failsLocally: async (args: { readonly receiver: AddressInput; readonly amount: bigint }, options?: LocalExecutionOptions): Promise<void>");
    expect(output).toContain("captureLocalFailure: async (args: { readonly receiver: AddressInput; readonly amount: bigint }, options?: LocalExecutionOptions): Promise<LocalTransitionError>");
    expect(output).toContain("submitted: async (args: { readonly receiver: AddressInput; readonly amount: bigint }, options?: OnChainExecutionOptions): Promise<SubmittedTransition>");
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
    expect(output).toContain('return this.expectAccepted("transfer"');
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
            { name: "a", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" as const },
            { name: "b", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" as const },
          ],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" as const },
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
    expect(output).toContain("async getBalances(key: AddressInput): Promise<bigint | null>");
    expect(output).toContain('this.queryMapping("balances"');
    // Should deserialize the returned value, not return raw string
    expect(output).toContain("if (_result === null) return null;");
    expect(output).toContain("BaseContract.parseBigInt(_result)");
  });

  it("generates factory function", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export function createTokenContract(): TokenContract");
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
          fields: [
            { name: "owner", ty: { Primitive: "Address" }, mode: "Private" as const },
          ],
        },
      ],
      mappings: [],
      storage_variables: [],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export class TokenContractContract extends BaseContract");
    expect(output).toContain("export function createTokenContractContract(): TokenContractContract");
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
            { ty: { Plaintext: { Array: [{ Struct: sref("Point") }, 3] } }, mode: "None" as const },
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
            { name: "amount", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" as const },
          ],
          outputs: [
            { ty: { Future: "vault.aleo" }, mode: "None" as const },
          ],
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
            { name: "receiver", ty: { Plaintext: { Primitive: "Address" as const } }, mode: "Public" as const },
          ],
          outputs: [
            { ty: { Record: rref("Token") }, mode: "None" as const },
            { ty: { Future: "token.aleo" }, mode: "None" as const },
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
          inputs: [
            { name: "record", ty: "DynamicRecord", mode: "None" as const },
          ],
          outputs: [
            { ty: "DynamicRecord", mode: "None" as const },
          ],
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
              mode: "None" as const,
            },
          ],
          outputs: [
            {
              ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } } },
              mode: "None" as const,
            },
          ],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain("info: PlaintextInput");
    expect(output).toContain("async getMetadata(key: FieldInput): Promise<LeoPlaintext | null>");
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
              mode: "None" as const,
            },
          ],
          outputs: [
            {
              ty: { Record: { path: ["credits"], program: "credits.aleo" } },
              mode: "None" as const,
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
              mode: "None" as const,
            },
          ],
          outputs: [
            {
              ty: { Plaintext: { Struct: { path: ["TokenInfo"], program: "registry.aleo" } } },
              mode: "None" as const,
            },
          ],
        },
      ],
    };

    const output = generateBindings(consumer, [consumer, registry]);
    expect(output).toContain('from "./Registry.js"');
    expect(output).toContain("readonly info: Registry_TokenInfo");
    expect(output).toContain("Promise<Registry_TokenInfo>");
    expect(output).toContain('serializeRegistry_TokenInfo(args.info as Registry_TokenInfo, this.inputContext("submit", "info"))');
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
              mode: "None" as const,
            },
          ],
          outputs: [
            {
              ty: { Record: { path: ["Credit"], program: "credits.aleo" } },
              mode: "None" as const,
            },
          ],
        },
      ],
    };

    const output = generateBindings(consumer, [consumer, credits]);
    expect(output).toContain('from "./Credits.js"');
    expect(output).toContain("readonly record: Credits_Credit");
    expect(output).toContain("Promise<Credits_Credit>");
    expect(output).toContain('serializeCredits_Credit(args.record as Credits_Credit, this.inputContext("forward", "record"))');
    expect(output).toContain('deserializeCredits_Credit(this.outputAt(_result, "forward", 0))');
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
          fields: [
            { name: "backup", ty: { Optional: { Primitive: { UInt: "U64" } } } },
          ],
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
          fields: [
            { name: "x", ty: { Primitive: { UInt: "U32" } } },
          ],
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
    expect(output).toContain('serializeInner(value.backup as Inner, BaseContract.childInputContext(context, "backup"))');
    expect(output).toContain('{ is_some: false, val: { x: 0u32 } }');
    expect(output).not.toContain('serializeUnsupportedOptionalNone');
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
    expect(output).toContain('readonly external: LeoPlaintext | null;');
    expect(output).toContain('BaseContract.serializeUnsupportedOptionalNone');
    expect(output).not.toContain('is_some: false, val:');
  });
});

describe("storage variables", () => {
  it("generates a storage interface for ABI storage variables", () => {
    const abi: ProgramABI = {
      program: "vault.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [
        { name: "admin", ty: { Plaintext: { Primitive: "Address" } } },
        { name: "whitelist", ty: { Vector: { Plaintext: { Primitive: "Address" } } } },
      ],
      transitions: [],
    };
    const output = generateBindings(abi);
    expect(output).toContain("export interface VaultStorage");
    expect(output).toContain("readonly admin: LeoAddress;");
    expect(output).toContain("readonly whitelist: LeoAddress[];");
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
            { name: "a", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" as const },
            { name: "b", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" as const },
          ],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" as const },
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" as const },
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
          inputs: [
            { name: "coin", ty: { Record: rref("Coin") }, mode: "None" as const },
          ],
          outputs: [
            { ty: { Record: rref("Coin") }, mode: "None" as const },
            { ty: { Record: rref("Coin") }, mode: "None" as const },
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
    expect(output).toContain("async getClaimed(key: AddressInput): Promise<boolean | null>");
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
    expect(output).toContain("async getEntries(key: FieldInput): Promise<LeoAddress | null>");
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
    expect(output).toContain("async getPairs(key: FieldInput): Promise<Pair | null>");
    expect(output).toContain("deserializePair(_result)");
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
    expect(output).toContain('serializePoint(value.start as Point, BaseContract.childInputContext(context, "start"))');
    expect(output).toContain('serializePoint(value.end as Point, BaseContract.childInputContext(context, "end"))');
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
            { name: "to", ty: { Plaintext: { Primitive: "Address" as const } }, mode: "None" as const },
          ],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain('BaseContract.serializeAddress(args.to, this.inputContext("send", "to"))');
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
            { name: "flag", ty: { Plaintext: { Primitive: "Boolean" as const } }, mode: "None" as const },
          ],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain('BaseContract.serializeBoolean(args.flag, this.inputContext("toggle", "flag"))');
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
            { name: "a", ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode: "None" as const },
            { name: "b", ty: { Plaintext: { Primitive: { Int: "I64" } } }, mode: "None" as const },
          ],
          outputs: [],
        },
      ],
    };
    const output = generateBindings(abi);
    expect(output).toContain('BaseContract.serializeUInt(args.a, 32, this.inputContext("compute", "a"))');
    expect(output).toContain('BaseContract.serializeInt(args.b, 64, this.inputContext("compute", "b"))');
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
            { name: "strategy", ty: { Plaintext: { Primitive: "Identifier" } }, mode: "None" as const },
            {
              name: "maybe_strategy",
              ty: { Plaintext: { Optional: { Primitive: "Identifier" } } },
              mode: "None" as const,
            },
            {
              name: "strategies",
              ty: { Plaintext: { Array: [{ Primitive: "Identifier" }, 2] } },
              mode: "None" as const,
            },
            { name: "vote", ty: { Record: rref("Vote") }, mode: "None" as const },
          ],
          outputs: [
            { ty: { Plaintext: { Primitive: "Identifier" } }, mode: "None" as const },
          ],
        },
      ],
    };

    const output = generateBindings(abi);
    expect(output).toContain("readonly strategy: IdentifierInput");
    expect(output).toContain("readonly maybe_strategy: IdentifierInput | null");
    expect(output).toContain("readonly strategies: ReadonlyArray<IdentifierInput>");
    expect(output).toContain('BaseContract.serializeIdentifier(args.strategy, this.inputContext("route", "strategy"))');
    expect(output).toContain('BaseContract.serializeIdentifier(value.strategy, BaseContract.childInputContext(context, "strategy"))');
    expect(output).toContain("BaseContract.serializeIdentifier(e, context)");
    expect(output).toContain("{ is_some: false, val: 'lionden_zero' }");
    expect(output).toContain('BaseContract.parseIdentifier(this.outputAt(_result, "route", 0))');
    expect(output).toContain("async getSelected_strategy(key: IdentifierInput): Promise<LeoIdentifier | null>");
    expect(output).toContain('this.queryMapping("selected_strategy", BaseContract.serializeIdentifier(key, { programId: this.programId, input: "selected_strategy key" }))');
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
              mode: "None" as const,
            },
          ],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode: "None" as const },
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
            { ty: { Plaintext: { Primitive: "Boolean" as const } }, mode: "None" as const },
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
            { ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode: "None" as const },
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
            { ty: { Plaintext: { Primitive: "Address" as const } }, mode: "None" as const },
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
            outputs: [
              { ty: { Plaintext: { Primitive: prim } }, mode: "None" as const },
            ],
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
            { name: "receiver", ty: { Plaintext: { Primitive: "Address" } }, mode: "Public" as const },
            { name: "record", ty: { Record: rref("Coin") }, mode: "None" as const },
            {
              name: "externalInfo",
              ty: { Plaintext: { Struct: { path: ["Info"], program: "registry.aleo" } } },
              mode: "None" as const,
            },
          ],
          outputs: [
            { ty: { Record: rref("Coin") }, mode: "None" as const },
            { ty: { Future: "check.aleo" }, mode: "None" as const },
          ],
        },
      ],
    };

    const output = generateBindings(abi);
    expectGeneratedToTypecheck("Check", output);
  });
});
