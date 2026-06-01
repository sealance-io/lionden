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
  // Structs (keyed by full path)
  // -------------------------------------------------------------------------

  it("allows adding new structs", () => {
    const oldAbi = makeAbi({ structs: [] });
    const newAbi = makeAbi({
      structs: [{ path: ["TokenInfo"], fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }] }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting a struct", () => {
    const oldAbi = makeAbi({
      structs: [{ path: ["TokenInfo"], fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }] }],
    });
    const newAbi = makeAbi({ structs: [] });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("struct_deleted");
  });

  it("rejects modifying a struct field", () => {
    const oldAbi = makeAbi({
      structs: [{ path: ["TokenInfo"], fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }] }],
    });
    const newAbi = makeAbi({
      structs: [{ path: ["TokenInfo"], fields: [{ name: "supply", ty: { Primitive: { UInt: "U128" } } }] }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("struct_modified");
  });

  it("rejects adding a field to existing struct", () => {
    const oldAbi = makeAbi({
      structs: [{ path: ["TokenInfo"], fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }] }],
    });
    const newAbi = makeAbi({
      structs: [{
        path: ["TokenInfo"],
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

  it("treats structs with different module paths as distinct", () => {
    const abi = makeAbi({
      structs: [
        { path: ["a", "Thing"], fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }] },
        { path: ["b", "Thing"], fields: [{ name: "y", ty: { Primitive: { UInt: "U64" } } }] },
      ],
    });
    // Same ABI compared to itself — should be compatible
    const result = checkAbiCompatibility(abi, abi);
    expect(result.compatible).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Records (keyed by full path)
  // -------------------------------------------------------------------------

  it("allows adding new records", () => {
    const oldAbi = makeAbi({ records: [] });
    const newAbi = makeAbi({
      records: [{
        path: ["Token"],
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
        path: ["Token"],
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
        path: ["Token"],
        fields: [
          { name: "owner", ty: { Primitive: "Address" }, mode: "Private" },
        ],
      }],
    });
    const newAbi = makeAbi({
      records: [{
        path: ["Token"],
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

  it("rejects modifying transition signature (inputs added)", () => {
    const oldAbi = makeAbi({
      transitions: [{ name: "transfer", is_async: false, inputs: [], outputs: [] }],
    });
    const newAbi = makeAbi({
      transitions: [{
        name: "transfer",
        is_async: false,
        inputs: [{ name: "to", ty: { Plaintext: { Primitive: "Address" } }, mode: "Public" }],
        outputs: [],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("transition_modified");
  });

  it("rejects changing transition from sync to async", () => {
    const oldAbi = makeAbi({
      transitions: [{
        name: "transfer",
        is_async: false,
        inputs: [{ name: "amount", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" }],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" }],
      }],
    });
    const newAbi = makeAbi({
      transitions: [{
        name: "transfer",
        is_async: true,
        inputs: [{ name: "amount", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" }],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" }],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("transition_modified");
    expect(result.violations[0]!.detail).toContain("async mode changed");
  });

  it("rejects changing transition input type", () => {
    const oldAbi = makeAbi({
      transitions: [{
        name: "deposit",
        is_async: false,
        inputs: [{ name: "amount", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" }],
        outputs: [],
      }],
    });
    const newAbi = makeAbi({
      transitions: [{
        name: "deposit",
        is_async: false,
        inputs: [{ name: "amount", ty: { Plaintext: { Primitive: { UInt: "U128" } } }, mode: "None" }],
        outputs: [],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("transition_modified");
    expect(result.violations[0]!.detail).toContain("input \"amount\" changed");
  });

  it("rejects changing transition output type", () => {
    const oldAbi = makeAbi({
      transitions: [{
        name: "get_balance",
        is_async: false,
        inputs: [],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" }],
      }],
    });
    const newAbi = makeAbi({
      transitions: [{
        name: "get_balance",
        is_async: false,
        inputs: [],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U128" } } }, mode: "None" }],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("transition_modified");
    expect(result.violations[0]!.detail).toContain("output[0] changed");
  });

  it("rejects removing an output from existing transition", () => {
    const oldAbi = makeAbi({
      transitions: [{
        name: "mint",
        is_async: false,
        inputs: [],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" }],
      }],
    });
    const newAbi = makeAbi({
      transitions: [{
        name: "mint",
        is_async: false,
        inputs: [],
        outputs: [],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("transition_modified");
    expect(result.violations[0]!.detail).toContain("output count changed");
  });

  it("rejects changing transition input mode", () => {
    const oldAbi = makeAbi({
      transitions: [{
        name: "transfer",
        is_async: false,
        inputs: [{ name: "to", ty: { Plaintext: { Primitive: "Address" } }, mode: "Private" }],
        outputs: [],
      }],
    });
    const newAbi = makeAbi({
      transitions: [{
        name: "transfer",
        is_async: false,
        inputs: [{ name: "to", ty: { Plaintext: { Primitive: "Address" } }, mode: "Public" }],
        outputs: [],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("transition_modified");
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
  // Views
  // -------------------------------------------------------------------------

  it("allows adding new views", () => {
    const oldAbi = makeAbi({ views: [] });
    const newAbi = makeAbi({
      views: [{
        name: "get_balance",
        inputs: [],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" }],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting a view", () => {
    const oldAbi = makeAbi({
      views: [{
        name: "get_balance",
        inputs: [],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" }],
      }],
    });
    const newAbi = makeAbi({ views: [] });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("view_deleted");
  });

  it("rejects modifying a view signature", () => {
    const oldAbi = makeAbi({
      views: [{
        name: "get_balance",
        inputs: [],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" }],
      }],
    });
    const newAbi = makeAbi({
      views: [{
        name: "get_balance",
        inputs: [],
        outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U128" } } }, mode: "Public" }],
      }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("view_modified");
  });

  // -------------------------------------------------------------------------
  // Implemented interfaces
  // -------------------------------------------------------------------------

  it("allows adding implemented interfaces", () => {
    const oldAbi = makeAbi({ implements: [] });
    const newAbi = makeAbi({
      implements: [{ path: ["Readable"], program: null }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting an implemented interface", () => {
    const oldAbi = makeAbi({
      implements: [{ path: ["Readable"], program: null }],
    });
    const newAbi = makeAbi({ implements: [] });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("interface_deleted");
    expect(result.violations[0]!.name).toBe("Readable");
  });

  it("rejects modifying an implemented interface ref", () => {
    const oldAbi = makeAbi({
      implements: [{ path: ["Readable"], program: null }],
    });
    const newAbi = makeAbi({
      implements: [{ path: ["Readable"], program: "interfaces.aleo" }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("interface_modified");
  });

  // -------------------------------------------------------------------------
  // Storage variables
  // -------------------------------------------------------------------------

  it("allows adding new storage variables", () => {
    const oldAbi = makeAbi({ storage_variables: [] });
    const newAbi = makeAbi({
      storage_variables: [{ name: "total_supply", ty: { Plaintext: { Primitive: { UInt: "U64" } } } }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(true);
  });

  it("rejects deleting a storage variable", () => {
    const oldAbi = makeAbi({
      storage_variables: [{ name: "total_supply", ty: { Plaintext: { Primitive: { UInt: "U64" } } } }],
    });
    const newAbi = makeAbi({ storage_variables: [] });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("storage_variable_deleted");
  });

  it("rejects modifying a storage variable type", () => {
    const oldAbi = makeAbi({
      storage_variables: [{ name: "total_supply", ty: { Plaintext: { Primitive: { UInt: "U64" } } } }],
    });
    const newAbi = makeAbi({
      storage_variables: [{ name: "total_supply", ty: { Plaintext: { Primitive: { UInt: "U128" } } } }],
    });
    const result = checkAbiCompatibility(oldAbi, newAbi);
    expect(result.compatible).toBe(false);
    expect(result.violations[0]!.kind).toBe("storage_variable_modified");
  });

  it("rejects changing storage variable from Plaintext to Vector", () => {
    const oldAbi = makeAbi({
      storage_variables: [{ name: "whitelist", ty: { Plaintext: { Primitive: "Address" } } }],
    });
    const newAbi = makeAbi({
      storage_variables: [{ name: "whitelist", ty: { Vector: { Plaintext: { Primitive: "Address" } } } }],
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
      structs: [{ path: ["Info"], fields: [{ name: "val", ty: { Primitive: { UInt: "U32" } } }] }],
    });
    const newAbi = makeAbi({
      mappings: [], // deleted
      transitions: [{ name: "mint", is_async: false, inputs: [], outputs: [] }], // burn deleted
      structs: [{ path: ["Info"], fields: [{ name: "val", ty: { Primitive: { UInt: "U64" } } }] }], // modified
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
