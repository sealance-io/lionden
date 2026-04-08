import { describe, it, expect } from "vitest";
import { checkAbiCompatibility } from "./abi-compat.js";
import type { ProgramABI } from "@lionden/leo-compiler";

function makeAbi(overrides: Partial<ProgramABI> = {}): ProgramABI {
  return {
    program: "test.aleo",
    structs: [],
    records: [],
    mappings: [],
    storage_variables: [],
    transitions: [],
    ...overrides,
  };
}

describe("checkAbiCompatibility", () => {
  // -------------------------------------------------------------------------
  // Identical ABIs
  // -------------------------------------------------------------------------

  it("reports compatible for identical ABIs", () => {
    const abi = makeAbi({
      mappings: [{ name: "balances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } }],
      transitions: [{ name: "transfer", is_async: false, inputs: [], outputs: [] }],
    });
    const result = checkAbiCompatibility(abi, abi);
    expect(result.compatible).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Mappings
  // -------------------------------------------------------------------------

  it("allows adding new mappings", () => {
    const oldAbi = makeAbi({
      mappings: [{ name: "balances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } }],
    });
    const newAbi = makeAbi({
      mappings: [
        { name: "balances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } },
        { name: "allowances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } },
      ],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting a mapping", () => {
    const oldAbi = makeAbi({
      mappings: [{ name: "balances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } }],
    });
    const newAbi = makeAbi({ mappings: [] });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.kind).toBe("mapping_deleted");
    expect(result.violations[0]!.name).toBe("balances");
  });

  it("rejects modifying mapping key type", () => {
    const oldAbi = makeAbi({
      mappings: [{ name: "balances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } }],
    });
    const newAbi = makeAbi({
      mappings: [{ name: "balances", key: { Primitive: "Field" }, value: { Primitive: { UInt: "U64" } } }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("mapping_modified");
  });

  it("rejects modifying mapping value type", () => {
    const oldAbi = makeAbi({
      mappings: [{ name: "balances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } }],
    });
    const newAbi = makeAbi({
      mappings: [{ name: "balances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U128" } } }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("mapping_modified");
  });

  // -------------------------------------------------------------------------
  // Structs
  // -------------------------------------------------------------------------

  it("allows adding new structs", () => {
    const oldAbi = makeAbi({ structs: [] });
    const newAbi = makeAbi({
      structs: [{ name: "TokenInfo", fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }] }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting a struct", () => {
    const oldAbi = makeAbi({
      structs: [{ name: "TokenInfo", fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }] }],
    });
    const newAbi = makeAbi({ structs: [] });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("struct_deleted");
  });

  it("rejects modifying a struct field", () => {
    const oldAbi = makeAbi({
      structs: [{ name: "TokenInfo", fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }] }],
    });
    const newAbi = makeAbi({
      structs: [{ name: "TokenInfo", fields: [{ name: "supply", ty: { Primitive: { UInt: "U128" } } }] }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("struct_modified");
  });

  it("rejects adding a field to existing struct", () => {
    const oldAbi = makeAbi({
      structs: [{ name: "TokenInfo", fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }] }],
    });
    const newAbi = makeAbi({
      structs: [{
        name: "TokenInfo",
        fields: [
          { name: "supply", ty: { Primitive: { UInt: "U64" } } },
          { name: "decimals", ty: { Primitive: { UInt: "U8" } } },
        ],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("struct_modified");
  });

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  it("allows adding new records", () => {
    const oldAbi = makeAbi({ records: [] });
    const newAbi = makeAbi({
      records: [{
        name: "Token",
        fields: [
          { name: "owner", ty: { Primitive: "Address" }, mode: "Private" },
          { name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "Private" },
        ],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting a record", () => {
    const oldAbi = makeAbi({
      records: [{
        name: "Token",
        fields: [
          { name: "owner", ty: { Primitive: "Address" }, mode: "Private" },
        ],
      }],
    });
    const newAbi = makeAbi({ records: [] });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("record_deleted");
  });

  it("rejects modifying record field mode", () => {
    const oldAbi = makeAbi({
      records: [{
        name: "Token",
        fields: [
          { name: "owner", ty: { Primitive: "Address" }, mode: "Private" },
        ],
      }],
    });
    const newAbi = makeAbi({
      records: [{
        name: "Token",
        fields: [
          { name: "owner", ty: { Primitive: "Address" }, mode: "Public" },
        ],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("record_modified");
  });

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  it("allows adding new transitions", () => {
    const oldAbi = makeAbi({
      transitions: [{ name: "mint", is_async: false, inputs: [], outputs: [] }],
    });
    const newAbi = makeAbi({
      transitions: [
        { name: "mint", is_async: false, inputs: [], outputs: [] },
        { name: "burn", is_async: false, inputs: [], outputs: [] },
      ],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("allows modifying transition signature", () => {
    const oldAbi = makeAbi({
      transitions: [{ name: "transfer", is_async: false, inputs: [], outputs: [] }],
    });
    const newAbi = makeAbi({
      transitions: [{
        name: "transfer",
        is_async: true,
        inputs: [{ name: "to", ty: { Plaintext: { Primitive: "Address" } }, mode: "Public" }],
        outputs: [],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting a transition", () => {
    const oldAbi = makeAbi({
      transitions: [
        { name: "mint", is_async: false, inputs: [], outputs: [] },
        { name: "burn", is_async: false, inputs: [], outputs: [] },
      ],
    });
    const newAbi = makeAbi({
      transitions: [{ name: "mint", is_async: false, inputs: [], outputs: [] }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("transition_deleted");
    expect(result.violations[0]!.name).toBe("burn");
  });

  // -------------------------------------------------------------------------
  // Storage variables
  // -------------------------------------------------------------------------

  it("allows adding new storage variables", () => {
    const oldAbi = makeAbi({ storage_variables: [] });
    const newAbi = makeAbi({
      storage_variables: [{ name: "total_supply", ty: { Primitive: { UInt: "U64" } } }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting a storage variable", () => {
    const oldAbi = makeAbi({
      storage_variables: [{ name: "total_supply", ty: { Primitive: { UInt: "U64" } } }],
    });
    const newAbi = makeAbi({ storage_variables: [] });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("storage_variable_deleted");
  });

  it("rejects modifying a storage variable type", () => {
    const oldAbi = makeAbi({
      storage_variables: [{ name: "total_supply", ty: { Primitive: { UInt: "U64" } } }],
    });
    const newAbi = makeAbi({
      storage_variables: [{ name: "total_supply", ty: { Primitive: { UInt: "U128" } } }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("storage_variable_modified");
  });

  // -------------------------------------------------------------------------
  // Multiple violations
  // -------------------------------------------------------------------------

  it("collects multiple violations", () => {
    const oldAbi = makeAbi({
      mappings: [{ name: "balances", key: { Primitive: "Address" }, value: { Primitive: { UInt: "U64" } } }],
      transitions: [
        { name: "mint", is_async: false, inputs: [], outputs: [] },
        { name: "burn", is_async: false, inputs: [], outputs: [] },
      ],
      structs: [{ name: "Info", fields: [{ name: "val", ty: { Primitive: { UInt: "U32" } } }] }],
    });
    const newAbi = makeAbi({
      mappings: [], // deleted
      transitions: [{ name: "mint", is_async: false, inputs: [], outputs: [] }], // burn deleted
      structs: [{ name: "Info", fields: [{ name: "val", ty: { Primitive: { UInt: "U64" } } }] }], // modified
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations.length).toBe(3);

    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain("mapping_deleted");
    expect(kinds).toContain("transition_deleted");
    expect(kinds).toContain("struct_modified");
  });
});
