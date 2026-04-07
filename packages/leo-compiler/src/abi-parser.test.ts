import { describe, it, expect } from "vitest";
import { parseAbi, AbiParseError } from "./abi-parser.js";

const VALID_ABI = JSON.stringify({
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
  storage_variables: [],
  transitions: [
    {
      name: "transfer",
      is_async: false,
      inputs: [
        { name: "receiver", ty: { Plaintext: { Primitive: "Address" } }, mode: "None" },
        { name: "amount", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" },
      ],
      outputs: [
        { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" },
      ],
    },
  ],
});

describe("parseAbi", () => {
  it("parses a valid ABI", () => {
    const abi = parseAbi(VALID_ABI);
    expect(abi.program).toBe("token.aleo");
    expect(abi.structs).toHaveLength(1);
    expect(abi.records).toHaveLength(1);
    expect(abi.mappings).toHaveLength(1);
    expect(abi.transitions).toHaveLength(1);
    expect(abi.transitions[0]!.name).toBe("transfer");
    expect(abi.transitions[0]!.inputs).toHaveLength(2);
    expect(abi.transitions[0]!.outputs).toHaveLength(1);
  });

  it("handles empty arrays", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "empty.aleo",
        structs: [],
        records: [],
        mappings: [],
        storage_variables: [],
        transitions: [],
      }),
    );
    expect(abi.program).toBe("empty.aleo");
    expect(abi.transitions).toHaveLength(0);
  });

  it("handles missing optional arrays", () => {
    const abi = parseAbi(JSON.stringify({ program: "minimal.aleo" }));
    expect(abi.program).toBe("minimal.aleo");
    expect(abi.structs).toEqual([]);
    expect(abi.transitions).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAbi("not json")).toThrow(AbiParseError);
    expect(() => parseAbi("not json")).toThrow("Invalid JSON");
  });

  it("throws on non-object", () => {
    expect(() => parseAbi('"string"')).toThrow("must be a JSON object");
  });

  it("throws on missing program field", () => {
    expect(() => parseAbi(JSON.stringify({ structs: [] }))).toThrow('missing required "program"');
  });

  it("throws on invalid transition structure", () => {
    const bad = JSON.stringify({
      program: "bad.aleo",
      transitions: [{ name: "foo" }],
    });
    expect(() => parseAbi(bad)).toThrow("missing 'inputs' array");
  });
});
