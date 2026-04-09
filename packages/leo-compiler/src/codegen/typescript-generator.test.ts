import { describe, it, expect } from "vitest";
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
    expect(output).toContain("readonly admin: string;");
  });

  it("generates record interfaces with owner and _nonce", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export interface Token");
    expect(output).toContain("readonly owner: string;");
    expect(output).toContain("readonly amount: bigint;");
    expect(output).toContain("readonly _nonce: string;");
  });

  it("generates struct serializers", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export function serializeTokenInfo");
  });

  it("generates record serializers using Leo syntax, not JSON", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export function serializeToken(value: Token): string");
    // Should NOT use JSON.stringify
    expect(output).not.toContain("JSON.stringify");
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
    expect(output).toContain("serializeCoin(coin)");
    expect(output).not.toContain("JSON.stringify");
  });

  it("generates contract class extending BaseContract", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export class Token extends BaseContract");
    expect(output).toContain('super("token.aleo")');
  });

  it("generates typed transition methods", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("async mint(");
    expect(output).toContain("receiver: string,");
    expect(output).toContain("amount: bigint,");
    expect(output).toContain("): Promise<Token>");
    expect(output).toContain("async transfer(");
    expect(output).toContain("): Promise<void>");
  });

  it("generates argument serialization in transition methods", () => {
    const output = generateBindings(SAMPLE_ABI);
    // mint() should serialize arguments and call this.execute()
    expect(output).toContain("const _args: string[]");
    expect(output).toContain('this.execute("mint"');
    // transfer() with void return should also call execute
    expect(output).toContain('this.execute("transfer"');
  });

  it("deserializes transition outputs to proper JS types", () => {
    const output = generateBindings(SAMPLE_ABI);
    // mint() returns Token (record) — should call deserializeToken, not return raw string
    expect(output).toContain("deserializeToken(_result.outputs[0]!)");
    expect(output).not.toContain("_result.outputs as any");
  });

  it("generates struct and record deserializers", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export function deserializeTokenInfo(value: string): TokenInfo");
    expect(output).toContain("BaseContract.parseBigInt");
    expect(output).toContain("BaseContract.parseString");
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
    expect(output).toContain("BaseContract.parseBigInt(_result.outputs[0]!)");
  });

  it("generates mapping accessors with deserialized values", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("async getBalances(key: string): Promise<bigint | null>");
    expect(output).toContain('this.queryMapping("balances"');
    // Should deserialize the returned value, not return raw string
    expect(output).toContain("if (_result === null) return null;");
    expect(output).toContain("BaseContract.parseBigInt(_result)");
  });

  it("generates factory function", () => {
    const output = generateBindings(SAMPLE_ABI);
    expect(output).toContain("export function createToken(): Token");
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
    expect(output).toContain("protected async execute(");
    expect(output).toContain("protected async queryMapping(");
    expect(output).toContain("TransitionCallResult");
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
    expect(output).toContain("async deposit(");
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
    expect(output).toContain("record: string,");
    expect(output).toContain("): Promise<string>");
    // Should pass through as-is, not JSON.stringify
    expect(output).not.toContain("JSON.stringify");
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
    expect(output).toContain("readonly admin: string;");
    expect(output).toContain("readonly backup: string | null;");
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
    expect(output).toContain('serializeInner(value.backup)');
    expect(output).toContain('{ is_some: false, val: { x: 0u32 } }');
    expect(output).not.toContain('Cannot serialize None for this Optional type');
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
    expect(output).toContain("deserializeCoin(_result.outputs[0]!)");
    expect(output).toContain("deserializeCoin(_result.outputs[1]!)");
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
    expect(output).toContain("async getClaimed(key: string): Promise<boolean | null>");
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
    expect(output).toContain("async getEntries(key: string): Promise<string | null>");
    // Key serialization — Field is passed as raw string
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
    expect(output).toContain("async getPairs(key: string): Promise<Pair | null>");
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
    expect(output).toContain("readonly cells: number[];");
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
    expect(output).toContain("serializePoint(value.start)");
    expect(output).toContain("serializePoint(value.end)");
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
    // Address should not get a suffix — just pass the string directly
    expect(output).toContain("to,");
    // Should NOT contain to.toString() + "address"
    expect(output).not.toContain('"address"');
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
    expect(output).toContain("String(flag)");
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
    expect(output).toContain('a.toString() + "u32"');
    expect(output).toContain('b.toString() + "i64"');
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
    // Array serialization uses .map()
    expect(output).toContain('.map((e: any) =>');
    expect(output).toContain('"u32"');
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
    expect(output).toContain("BaseContract.parseBoolean(_result.outputs[0]!)");
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
    expect(output).toContain("BaseContract.parseNumber(_result.outputs[0]!)");
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
    expect(output).toContain("): Promise<string>");
    expect(output).toContain("BaseContract.parseString(_result.outputs[0]!)");
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
      expect(output).toContain("): Promise<string>");
      expect(output).toContain("BaseContract.parseString(_result.outputs[0]!)");
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
