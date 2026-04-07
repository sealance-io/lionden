import { describe, it, expect } from "vitest";
import { generateBindings, generateBaseContract } from "./typescript-generator.js";
import type { ProgramABI } from "../abi-types.js";

const SAMPLE_ABI: ProgramABI = {
  program: "token.aleo",
  structs: [
    {
      name: "TokenInfo",
      fields: [
        { name: "supply", ty: { Primitive: { UInt: "U64" } } },
        { name: "admin", ty: { Primitive: "Address" } },
      ],
    },
  ],
  records: [
    {
      name: "Token",
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
        { ty: { Record: "Token" }, mode: "None" as const },
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
          name: "Coin",
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
            { name: "coin", ty: { Record: "Coin" }, mode: "None" as const },
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
          name: "Point",
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
            { ty: { Plaintext: { Array: [{ Struct: "Point" }, 3] } }, mode: "None" as const },
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
});
