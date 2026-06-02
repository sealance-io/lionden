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
      "export declare function decryptValueCiphertext(ciphertext: string, viewKey: string, tpk: string, programId: string, transitionName: string, globalIndex: number, options?: { readonly network?: \"testnet\" | \"mainnet\" }): Promise<string>;",
      "export declare function deriveViewKey(privateKey: string, options?: { readonly network?: \"testnet\" | \"mainnet\" }): Promise<string>;",
      "export declare function programAddressFromProgramId(programId: string): string;",
      "export declare class LocalVmExecutionError extends Error {",
      "  readonly kind: \"LocalVmExecutionError\";",
      "  readonly programId: string;",
      "  readonly transitionName: string;",
      "  constructor(message: string, context: { readonly programId: string; readonly transitionName: string; readonly cause?: unknown });",
      "}",
      "export declare class NetworkRecordDecryptionError extends Error {",
      "  readonly kind: \"NetworkRecordDecryptionError\";",
      "  readonly ciphertextPrefix: string;",
      "  constructor(message: string, ciphertextPrefix: string, cause?: unknown);",
      "}",
      "export declare class NetworkValueDecryptionError extends Error {",
      "  readonly kind: \"NetworkValueDecryptionError\";",
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
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" },
          ],
        },
      ],
    };

    const output = generateBindings(abi);
    expect(output).not.toContain("readonly balance");
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
    expect(output).toContain("export function serializeToken(value: TokenInput, context?: TransitionInputContext): string");
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
    expect(output).toContain('serializeCoin(args.coin as CoinInput, this.inputContext("spend", "coin"))');
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
    // Mappings are exposed under a `mappings` namespace mirroring Leo's read ops.
    expect(output).toContain("readonly mappings = {");
    expect(output).toContain("balances: {");
    expect(output).toContain("contains: async (key: AddressInput): Promise<boolean> =>");
    expect(output).toContain("get: async (key: AddressInput): Promise<bigint> =>");
    expect(output).toContain("getOrUse: async (key: AddressInput, def: bigint): Promise<bigint> =>");
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
    expect(output).toContain("export function createTokenContract(options?: BaseContractOptions): TokenContract");
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
    expect(output).toContain("export function createTokenContractContract(options?: BaseContractOptions): TokenContractContract");
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
    expect(output).toContain('serializeRegistry_TokenInfo(args.info as Registry_TokenInfoInput, this.inputContext("submit", "info"))');
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
    expect(output).toContain('serializeCredits_Credit(args.record as Credits_CreditInput, this.inputContext("forward", "record"))');
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
    expect(output).toContain('serializeInner(value.backup as InnerInput, BaseContract.childInputContext(context, "backup"))');
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
    expect(output).toContain('serializePoint(value.start as PointInput, BaseContract.childInputContext(context, "start"))');
    expect(output).toContain('serializePoint(value.end as PointInput, BaseContract.childInputContext(context, "end"))');
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
    expect(output).toContain("selectedStrategy: {");
    expect(output).toContain("get: async (key: IdentifierInput): Promise<LeoIdentifier> =>");
    expect(output).toContain("tryGet: async (key: IdentifierInput): Promise<LeoIdentifier | null> =>");
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

describe("interface conversion helper emission", () => {
  const TOKEN_ABI: ProgramABI = {
    program: "stable_token.aleo",
    structs: [],
    records: [
      {
        path: ["Token"],
        fields: [
          { name: "amount", ty: { Primitive: { UInt: "U128" } }, mode: "None" },
          { name: "_version", ty: { Primitive: { UInt: "U8" } }, mode: "None" },
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
    expect(output).toMatch(/import \{ BaseContract, Leo, createRecordOutputMatcher, .*type RecordOutputMatcher/);
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
            { name: "data", ty: { Array: [{ Primitive: { UInt: "U8" } }, 4] }, mode: "None" },
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
          fields: [
            { name: "id", ty: { Primitive: "Identifier" }, mode: "None" },
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
          fields: [
            { name: "amount", ty: { Primitive: { UInt: "U128" } }, mode: "None" },
          ],
        },
      ],
      mappings: [],
      storage_variables: [],
      transitions: [
        {
          name: "demo",
          is_async: true,
          inputs: [],
          outputs: outputs.map((o) => ({ ty: o.ty, mode: "None" as const })),
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
    expect(output).not.toContain('BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 0)');
    expect(output).toContain("Promise<AcceptedTransition<EncryptedRecord<Token>>>");
  });

  it("[Token, Future, u128] wraps rawOutputs[0] and rawOutputs[2], skipping index 1", () => {
    // u128 is mode: "None" (default-private) in abiWithOutputs, so it becomes
    // EncryptedValue<bigint> rather than bare bigint.
    const abi = abiWithOutputs([
      { ty: { Record: rref("Token") } },
      { ty: { Future: "demo.aleo" } },
      { ty: { Plaintext: { Primitive: { UInt: "U128" } } } },
    ]);
    const output = generateBindings(abi);
    expect(output).toContain('BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 0)');
    expect(output).toContain('BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 2)');
    expect(output).not.toContain('BaseContract.rawOutputAt(rawOutputs, "future_demo.aleo", "demo", 1)');
    expect(output).toContain("Promise<AcceptedTransition<[EncryptedRecord<Token>, EncryptedValue<bigint>]>>");
  });

  it("all-Future outputs project to AcceptedTransition<void>", () => {
    const abi = abiWithOutputs([{ ty: { Future: "demo.aleo" } }]);
    const output = generateBindings(abi);
    expect(output).toContain("Promise<AcceptedTransition<void>>");
    expect(output).toContain("(_rawOutputs: readonly RawTransitionOutput[], _tpk: string, _transitions: readonly ConfirmedTransitionRecord[]) => undefined as void");
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
    mode: "None" | "Public" | "Private",
    inputs: readonly { name: string; mode: "None" | "Public" | "Private" }[] = [],
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
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode },
          ],
        },
      ],
    };
  }

  it("public plaintext output is eagerly decoded (no EncryptedValue handle)", () => {
    const out = generateBindings(abiOneOutput("Public"));
    expect(out).toContain("Promise<AcceptedTransition<bigint>>");
    expect(out).toContain('BaseContract.parseBigInt(BaseContract.rawOutputAt(rawOutputs, "mode_demo.aleo", "demo", 0))');
    // EncryptedValue may appear in the import list, but never as a generic
    // type instantiation in this public-only program.
    expect(out).not.toContain("EncryptedValue<");
    expect(out).not.toContain("makeEncryptedValue");
    // Projector uses _tpk since no private plaintext consumer.
    expect(out).toContain("_tpk: string");
  });

  it('private plaintext output (mode "None") wraps as EncryptedValue<T>', () => {
    const out = generateBindings(abiOneOutput("None"));
    expect(out).toContain("Promise<AcceptedTransition<EncryptedValue<bigint>>>");
    expect(out).toContain('BaseContract.makeEncryptedValue(BaseContract.rawOutputAt(rawOutputs, "mode_demo.aleo", "demo", 0), tpk, "mode_demo.aleo", "demo", 0, BaseContract.parseBigInt)');
    // Projector binds `tpk` (no underscore) since at least one private plaintext.
    expect(out).toMatch(/\(rawOutputs: readonly RawTransitionOutput\[\], tpk: string, _transitions: readonly ConfirmedTransitionRecord\[\]\) =>/);
  });

  it('explicit "Private" mode behaves the same as "None"', () => {
    const out = generateBindings(abiOneOutput("Private"));
    expect(out).toContain("Promise<AcceptedTransition<EncryptedValue<bigint>>>");
    expect(out).toContain("BaseContract.makeEncryptedValue");
  });

  it("globalIndex = inputs.length + abiIndex for private plaintext outputs", () => {
    // 2 inputs + 1 private u64 output → output@abiIndex=0 → globalIndex=2.
    const out = generateBindings(
      abiOneOutput("None", [
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
          inputs: [{ name: "x", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" }],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" },
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" },
          ],
        },
      ],
    };
    const out = generateBindings(abi);
    expect(out).toContain("Promise<AcceptedTransition<[bigint, EncryptedValue<bigint>]>>");
    // Public@abi0 → eager parse on rawOutputs[0].
    expect(out).toContain('BaseContract.parseBigInt(BaseContract.rawOutputAt(rawOutputs, "mixed_mode.aleo", "demo", 0))');
    // Private@abi1 → makeEncryptedValue on rawOutputs[1] with globalIndex 1 + 1 = 2.
    expect(out).toContain('BaseContract.makeEncryptedValue(BaseContract.rawOutputAt(rawOutputs, "mixed_mode.aleo", "demo", 1), tpk, "mixed_mode.aleo", "demo", 2, BaseContract.parseBigInt)');
  });
});
