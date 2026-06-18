import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AbiParseError, parseAbi } from "./abi-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "__fixtures__/abi");

// ---------------------------------------------------------------------------
// Helpers — normalized (internal) format
// ---------------------------------------------------------------------------

const VALID_ABI = JSON.stringify({
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
      outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "None" }],
    },
  ],
});

// ---------------------------------------------------------------------------
// Basic parsing (normalized format)
// ---------------------------------------------------------------------------

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
      transitions: [{ name: "foo", inputs: "not-an-array", outputs: [] }],
    });
    expect(() => parseAbi(bad)).toThrow("missing 'inputs' array");
  });
});

// ---------------------------------------------------------------------------
// Compiler format normalization (functions → transitions, is_final → is_async)
// ---------------------------------------------------------------------------

describe("parseAbi — compiler format normalization", () => {
  it("normalizes 'functions' key to transitions", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "hello.aleo",
        functions: [
          {
            name: "main",
            is_final: false,
            inputs: [
              { name: "a", ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode: "None" },
            ],
            outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode: "None" }],
          },
        ],
      }),
    );
    expect(abi.transitions).toHaveLength(1);
    expect(abi.transitions[0]!.name).toBe("main");
  });

  it("maps is_final to is_async", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        functions: [
          { name: "sync_fn", is_final: false, inputs: [], outputs: [] },
          { name: "async_fn", is_final: true, inputs: [], outputs: [] },
        ],
      }),
    );
    expect(abi.transitions[0]!.is_async).toBe(false);
    expect(abi.transitions[1]!.is_async).toBe(true);
  });

  it("prefers 'functions' over 'transitions' when both present", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        functions: [{ name: "from_functions", is_final: false, inputs: [], outputs: [] }],
        transitions: [{ name: "from_transitions", is_async: false, inputs: [], outputs: [] }],
      }),
    );
    expect(abi.transitions).toHaveLength(1);
    expect(abi.transitions[0]!.name).toBe("from_functions");
  });

  it("falls back to 'transitions' when 'functions' is absent", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        transitions: [{ name: "legacy", is_async: false, inputs: [], outputs: [] }],
      }),
    );
    expect(abi.transitions).toHaveLength(1);
    expect(abi.transitions[0]!.name).toBe("legacy");
  });

  it("normalizes Leo 4.1 views, implements, and const parameters", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "view_demo.aleo",
        implements: ["Readable", { path: ["admin", "Owned"], program: "owned_interface.aleo" }],
        functions: [
          {
            name: "execute",
            const_parameters: [{ name: "N", type: "u8" }],
            inputs: [],
            outputs: [],
          },
        ],
        views: [
          {
            name: "get",
            inputs: [
              {
                name: "account",
                ty: { Plaintext: { Primitive: "Address" } },
                mode: "Public",
              },
            ],
            outputs: [
              {
                ty: { Plaintext: { Primitive: { UInt: "U64" } } },
                mode: "Public",
              },
            ],
          },
        ],
      }),
    );

    expect(abi.implements).toEqual([
      "Readable",
      { path: ["admin", "Owned"], program: "owned_interface.aleo" },
    ]);
    expect(abi.transitions[0]!.const_parameters).toEqual([{ name: "N", type: "u8" }]);
    expect(abi.views).toHaveLength(1);
    expect(abi.views?.[0]).toMatchObject({
      name: "get",
      inputs: [{ name: "account", mode: "Public" }],
      outputs: [{ mode: "Public" }],
    });
  });

  it("omits empty Leo 4.1 extension fields after normalization", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "plain.aleo",
        functions: [{ name: "main", const_parameters: [], inputs: [], outputs: [] }],
        views: [],
        implements: [],
      }),
    );

    expect(abi.views).toBeUndefined();
    expect(abi.implements).toBeUndefined();
    expect(abi.transitions[0]!.const_parameters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Struct/Record path preservation
// ---------------------------------------------------------------------------

describe("parseAbi — path preservation", () => {
  it("preserves single-segment struct path", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["TokenInfo"],
            fields: [{ name: "supply", ty: { Primitive: { UInt: "U64" } } }],
          },
        ],
      }),
    );
    expect(abi.structs[0]!.path).toEqual(["TokenInfo"]);
  });

  it("preserves module-scoped struct path", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["utils", "Vector3"],
            fields: [
              { name: "x", ty: { Primitive: { UInt: "U32" } } },
              { name: "y", ty: { Primitive: { UInt: "U32" } } },
              { name: "z", ty: { Primitive: { UInt: "U32" } } },
            ],
          },
        ],
      }),
    );
    expect(abi.structs[0]!.path).toEqual(["utils", "Vector3"]);
    expect(abi.structs[0]!.fields).toHaveLength(3);
  });

  it("preserves record path", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        records: [
          {
            path: ["Token"],
            fields: [
              { name: "owner", ty: { Primitive: "Address" }, mode: "None" },
              { name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "None" },
            ],
          },
        ],
      }),
    );
    expect(abi.records[0]!.path).toEqual(["Token"]);
    expect(abi.records[0]!.fields).toHaveLength(2);
    expect(abi.records[0]!.fields[0]!.mode).toBe("None");
  });

  it("wraps bare name into single-element path (backwards compat)", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [{ name: "Point", fields: [] }],
        records: [{ name: "Coin", fields: [] }],
      }),
    );
    expect(abi.structs[0]!.path).toEqual(["Point"]);
    expect(abi.records[0]!.path).toEqual(["Coin"]);
  });

  it("does not collapse different module paths to same identity", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          { path: ["a", "Thing"], fields: [{ name: "x", ty: { Primitive: { UInt: "U32" } } }] },
          { path: ["b", "Thing"], fields: [{ name: "y", ty: { Primitive: { UInt: "U64" } } }] },
        ],
      }),
    );
    expect(abi.structs).toHaveLength(2);
    expect(abi.structs[0]!.path).toEqual(["a", "Thing"]);
    expect(abi.structs[1]!.path).toEqual(["b", "Thing"]);
  });

  it("throws when struct has neither name nor path", () => {
    expect(() =>
      parseAbi(
        JSON.stringify({
          program: "test.aleo",
          structs: [{ fields: [] }],
        }),
      ),
    ).toThrow("missing both 'name' and 'path'");
  });
});

// ---------------------------------------------------------------------------
// Type normalization — Plaintext (preserves full identity)
// ---------------------------------------------------------------------------

describe("parseAbi — plaintext type normalization", () => {
  it("preserves struct ref with path and program", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["Wrapper"],
            fields: [
              {
                name: "inner",
                ty: { Struct: { path: ["TokenInfo"], program: null } },
              },
            ],
          },
        ],
      }),
    );
    expect(abi.structs[0]!.fields[0]!.ty).toEqual({
      Struct: { path: ["TokenInfo"], program: null },
    });
  });

  it("preserves external struct ref with program identity", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["Composite"],
            fields: [
              {
                name: "vec",
                ty: { Struct: { path: ["utils", "Vector3"], program: "math.aleo" } },
              },
            ],
          },
        ],
      }),
    );
    expect(abi.structs[0]!.fields[0]!.ty).toEqual({
      Struct: { path: ["utils", "Vector3"], program: "math.aleo" },
    });
  });

  it("upgrades bare string struct ref to full StructRef", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["Wrapper"],
            fields: [{ name: "inner", ty: { Struct: "TokenInfo" } }],
          },
        ],
      }),
    );
    expect(abi.structs[0]!.fields[0]!.ty).toEqual({
      Struct: { path: ["TokenInfo"], program: null },
    });
  });

  it("normalizes array with object format to tuple format", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["Grid"],
            fields: [
              {
                name: "cells",
                ty: { Array: { element: { Primitive: { UInt: "U32" } }, length: 9 } },
              },
            ],
          },
        ],
      }),
    );
    expect(abi.structs[0]!.fields[0]!.ty).toEqual({
      Array: [{ Primitive: { UInt: "U32" } }, 9],
    });
  });

  it("passes through already-normalized array tuple format", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["Grid"],
            fields: [{ name: "cells", ty: { Array: [{ Primitive: { UInt: "U32" } }, 9] } }],
          },
        ],
      }),
    );
    expect(abi.structs[0]!.fields[0]!.ty).toEqual({
      Array: [{ Primitive: { UInt: "U32" } }, 9],
    });
  });

  it("normalizes nested array types", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["Matrix"],
            fields: [
              {
                name: "data",
                ty: {
                  Array: {
                    element: {
                      Array: { element: { Primitive: { UInt: "U32" } }, length: 3 },
                    },
                    length: 3,
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    const ty = abi.structs[0]!.fields[0]!.ty;
    expect(ty).toEqual({
      Array: [{ Array: [{ Primitive: { UInt: "U32" } }, 3] }, 3],
    });
  });

  it("preserves Optional wrapper", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        structs: [
          {
            path: ["MaybeValue"],
            fields: [{ name: "val", ty: { Optional: { Primitive: { UInt: "U64" } } } }],
          },
        ],
      }),
    );
    expect(abi.structs[0]!.fields[0]!.ty).toEqual({
      Optional: { Primitive: { UInt: "U64" } },
    });
  });
});

// ---------------------------------------------------------------------------
// Type normalization — FunctionInput/FunctionOutput (AleoType)
// ---------------------------------------------------------------------------

describe("parseAbi — function type normalization", () => {
  it("normalizes 'Final' output to Future", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        functions: [
          {
            name: "do_async",
            is_final: true,
            inputs: [],
            outputs: [{ ty: "Final", mode: "None" }],
          },
        ],
      }),
    );
    expect(abi.transitions[0]!.outputs[0]!.ty).toEqual({ Future: "test.aleo" });
  });

  it("preserves DynamicRecord as first-class variant", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        functions: [
          {
            name: "forward",
            is_final: false,
            inputs: [{ name: "rec", ty: "DynamicRecord", mode: "None" }],
            outputs: [{ ty: "DynamicRecord", mode: "None" }],
          },
        ],
      }),
    );
    expect(abi.transitions[0]!.inputs[0]!.ty).toBe("DynamicRecord");
    expect(abi.transitions[0]!.outputs[0]!.ty).toBe("DynamicRecord");
  });

  it("preserves Record ref with path and program in input", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "token.aleo",
        functions: [
          {
            name: "spend",
            is_final: false,
            inputs: [
              {
                name: "token",
                ty: { Record: { path: ["Token"], program: "token.aleo" } },
                mode: "None",
              },
            ],
            outputs: [],
          },
        ],
      }),
    );
    expect(abi.transitions[0]!.inputs[0]!.ty).toEqual({
      Record: { path: ["Token"], program: "token.aleo" },
    });
  });

  it("preserves Record ref with path and program in output", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "token.aleo",
        functions: [
          {
            name: "mint",
            is_final: false,
            inputs: [],
            outputs: [
              {
                ty: { Record: { path: ["Token"], program: "token.aleo" } },
                mode: "None",
              },
            ],
          },
        ],
      }),
    );
    expect(abi.transitions[0]!.outputs[0]!.ty).toEqual({
      Record: { path: ["Token"], program: "token.aleo" },
    });
  });

  it("upgrades bare string Record ref to full RecordRef", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "token.aleo",
        transitions: [
          {
            name: "mint",
            is_async: false,
            inputs: [],
            outputs: [{ ty: { Record: "Token" }, mode: "None" }],
          },
        ],
      }),
    );
    expect(abi.transitions[0]!.outputs[0]!.ty).toEqual({
      Record: { path: ["Token"], program: null },
    });
  });

  it("passes through Future type", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "token.aleo",
        transitions: [
          {
            name: "mint",
            is_async: true,
            inputs: [],
            outputs: [{ ty: { Future: "token.aleo" }, mode: "None" }],
          },
        ],
      }),
    );
    expect(abi.transitions[0]!.outputs[0]!.ty).toEqual({ Future: "token.aleo" });
  });

  it("normalizes bare 'Future' string output to Future (v3.5 ABI format)", () => {
    // Leo v3.5 emits "Future" as a bare string (like "Final" in v4),
    // not as { Future: "program.aleo" }.
    const abi = parseAbi(
      JSON.stringify({
        program: "deposit.aleo",
        transitions: [
          {
            name: "deposit",
            is_async: true,
            inputs: [
              { name: "amount", ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" },
            ],
            outputs: [{ ty: "Future", mode: "None" }],
          },
        ],
      }),
    );
    expect(abi.transitions[0]!.outputs[0]!.ty).toEqual({ Future: "deposit.aleo" });
  });

  it("normalizes nested Plaintext types in function inputs", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        functions: [
          {
            name: "process",
            is_final: false,
            inputs: [
              {
                name: "info",
                ty: {
                  Plaintext: {
                    Struct: { path: ["TokenInfo"], program: null },
                  },
                },
                mode: "None",
              },
            ],
            outputs: [],
          },
        ],
      }),
    );
    expect(abi.transitions[0]!.inputs[0]!.ty).toEqual({
      Plaintext: { Struct: { path: ["TokenInfo"], program: null } },
    });
  });
});

// ---------------------------------------------------------------------------
// Mapping normalization
// ---------------------------------------------------------------------------

describe("parseAbi — mapping normalization", () => {
  it("normalizes mapping key and value types", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        mappings: [
          {
            name: "data",
            key: { Struct: { path: ["MyKey"], program: null } },
            value: { Primitive: { UInt: "U64" } },
          },
        ],
      }),
    );
    expect(abi.mappings[0]!.key).toEqual({
      Struct: { path: ["MyKey"], program: null },
    });
    expect(abi.mappings[0]!.value).toEqual({ Primitive: { UInt: "U64" } });
  });

  it("parses mapping with Boolean value", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        mappings: [
          {
            name: "claimed",
            key: { Primitive: "Address" },
            value: { Primitive: "Boolean" },
          },
        ],
      }),
    );
    expect(abi.mappings[0]!.value).toEqual({ Primitive: "Boolean" });
  });

  it("detects struct ref identity change in mapping values", () => {
    const abi1 = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        mappings: [
          {
            name: "data",
            key: { Primitive: "Field" },
            value: { Struct: { path: ["utils", "Thing"], program: null } },
          },
        ],
      }),
    );
    const abi2 = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        mappings: [
          {
            name: "data",
            key: { Primitive: "Field" },
            value: { Struct: { path: ["other", "Thing"], program: "lib.aleo" } },
          },
        ],
      }),
    );
    // Full refs differ — JSON.stringify will produce different strings
    expect(JSON.stringify(abi1.mappings[0]!.value)).not.toBe(
      JSON.stringify(abi2.mappings[0]!.value),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage variable normalization (preserves StorageType)
// ---------------------------------------------------------------------------

describe("parseAbi — storage variable normalization", () => {
  it("wraps bare PlaintextType in Plaintext StorageType", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        storage_variables: [{ name: "admin", ty: { Primitive: "Address" } }],
      }),
    );
    expect(abi.storage_variables).toHaveLength(1);
    expect(abi.storage_variables[0]!.name).toBe("admin");
    expect(abi.storage_variables[0]!.ty).toEqual({
      Plaintext: { Primitive: "Address" },
    });
  });

  it("preserves StorageType.Plaintext wrapper", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        storage_variables: [{ name: "admin", ty: { Plaintext: { Primitive: "Address" } } }],
      }),
    );
    expect(abi.storage_variables[0]!.ty).toEqual({
      Plaintext: { Primitive: "Address" },
    });
  });

  it("preserves StorageType.Vector wrapper", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        storage_variables: [
          {
            name: "whitelist",
            ty: { Vector: { Plaintext: { Primitive: "Address" } } },
          },
        ],
      }),
    );
    expect(abi.storage_variables[0]!.ty).toEqual({
      Vector: { Plaintext: { Primitive: "Address" } },
    });
  });

  it("distinguishes Plaintext from Vector in storage variables", () => {
    const abiPlain = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        storage_variables: [{ name: "val", ty: { Plaintext: { Primitive: "Address" } } }],
      }),
    );
    const abiVec = parseAbi(
      JSON.stringify({
        program: "test.aleo",
        storage_variables: [
          { name: "val", ty: { Vector: { Plaintext: { Primitive: "Address" } } } },
        ],
      }),
    );
    expect(JSON.stringify(abiPlain.storage_variables[0]!.ty)).not.toBe(
      JSON.stringify(abiVec.storage_variables[0]!.ty),
    );
  });
});

// ---------------------------------------------------------------------------
// All primitive types
// ---------------------------------------------------------------------------

describe("parseAbi — all primitive types", () => {
  const primitives = ["Address", "Boolean", "Field", "Group", "Identifier", "Scalar", "Signature"];

  for (const prim of primitives) {
    it(`parses ${prim} primitive`, () => {
      const abi = parseAbi(
        JSON.stringify({
          program: "test.aleo",
          mappings: [{ name: "m", key: { Primitive: prim }, value: { Primitive: prim } }],
        }),
      );
      expect(abi.mappings[0]!.key).toEqual({ Primitive: prim });
    });
  }

  const uints = ["U8", "U16", "U32", "U64", "U128"];
  for (const size of uints) {
    it(`parses UInt ${size}`, () => {
      const abi = parseAbi(
        JSON.stringify({
          program: "test.aleo",
          mappings: [
            { name: "m", key: { Primitive: "Address" }, value: { Primitive: { UInt: size } } },
          ],
        }),
      );
      expect(abi.mappings[0]!.value).toEqual({ Primitive: { UInt: size } });
    });
  }

  const ints = ["I8", "I16", "I32", "I64", "I128"];
  for (const size of ints) {
    it(`parses Int ${size}`, () => {
      const abi = parseAbi(
        JSON.stringify({
          program: "test.aleo",
          mappings: [
            { name: "m", key: { Primitive: "Address" }, value: { Primitive: { Int: size } } },
          ],
        }),
      );
      expect(abi.mappings[0]!.value).toEqual({ Primitive: { Int: size } });
    });
  }
});

// ---------------------------------------------------------------------------
// All mode values
// ---------------------------------------------------------------------------

describe("parseAbi — all mode values", () => {
  for (const mode of ["None", "Public", "Private"] as const) {
    it(`preserves ${mode} mode on function inputs`, () => {
      const abi = parseAbi(
        JSON.stringify({
          program: "test.aleo",
          functions: [
            {
              name: "fn",
              is_final: false,
              inputs: [{ name: "x", ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode }],
              outputs: [],
            },
          ],
        }),
      );
      expect(abi.transitions[0]!.inputs[0]!.mode).toBe(mode);
    });
  }

  for (const mode of ["None", "Public", "Private"] as const) {
    it(`preserves ${mode} mode on record fields`, () => {
      const abi = parseAbi(
        JSON.stringify({
          program: "test.aleo",
          records: [
            {
              path: ["Rec"],
              fields: [{ name: "val", ty: { Primitive: { UInt: "U32" } }, mode }],
            },
          ],
        }),
      );
      expect(abi.records[0]!.fields[0]!.mode).toBe(mode);
    });
  }
});

// ---------------------------------------------------------------------------
// Complex ABI — all features combined
// ---------------------------------------------------------------------------

describe("parseAbi — complex ABI with all features", () => {
  it("parses a complex ABI in compiler format", () => {
    const abi = parseAbi(
      JSON.stringify({
        program: "dex.aleo",
        structs: [
          {
            path: ["Pair"],
            fields: [
              { name: "token_a", ty: { Primitive: "Address" } },
              { name: "token_b", ty: { Primitive: "Address" } },
              { name: "reserve_a", ty: { Primitive: { UInt: "U128" } } },
              { name: "reserve_b", ty: { Primitive: { UInt: "U128" } } },
            ],
          },
        ],
        records: [
          {
            path: ["LPToken"],
            fields: [
              { name: "owner", ty: { Primitive: "Address" }, mode: "None" },
              { name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "None" },
              { name: "pair_id", ty: { Primitive: "Field" }, mode: "None" },
            ],
          },
        ],
        mappings: [
          {
            name: "pairs",
            key: { Primitive: "Field" },
            value: { Struct: { path: ["Pair"], program: null } },
          },
          {
            name: "total_supply",
            key: { Primitive: "Field" },
            value: { Primitive: { UInt: "U128" } },
          },
        ],
        storage_variables: [{ name: "admin", ty: { Plaintext: { Primitive: "Address" } } }],
        functions: [
          {
            name: "add_liquidity",
            is_final: true,
            inputs: [
              { name: "pair_id", ty: { Plaintext: { Primitive: "Field" } }, mode: "Public" },
              {
                name: "amount_a",
                ty: { Plaintext: { Primitive: { UInt: "U128" } } },
                mode: "Public",
              },
              {
                name: "amount_b",
                ty: { Plaintext: { Primitive: { UInt: "U128" } } },
                mode: "Public",
              },
            ],
            outputs: [
              { ty: { Record: { path: ["LPToken"], program: "dex.aleo" } }, mode: "None" },
              { ty: "Final", mode: "None" },
            ],
          },
          {
            name: "remove_liquidity",
            is_final: true,
            inputs: [
              {
                name: "lp_token",
                ty: { Record: { path: ["LPToken"], program: "dex.aleo" } },
                mode: "None",
              },
            ],
            outputs: [{ ty: "Final", mode: "None" }],
          },
          {
            name: "swap",
            is_final: false,
            inputs: [
              { name: "pair_id", ty: { Plaintext: { Primitive: "Field" } }, mode: "None" },
              {
                name: "amount_in",
                ty: { Plaintext: { Primitive: { UInt: "U128" } } },
                mode: "None",
              },
            ],
            outputs: [{ ty: { Plaintext: { Primitive: { UInt: "U128" } } }, mode: "None" }],
          },
        ],
      }),
    );

    // Program
    expect(abi.program).toBe("dex.aleo");

    // Structs — full path preserved
    expect(abi.structs).toHaveLength(1);
    expect(abi.structs[0]!.path).toEqual(["Pair"]);
    expect(abi.structs[0]!.fields).toHaveLength(4);

    // Records — full path preserved
    expect(abi.records).toHaveLength(1);
    expect(abi.records[0]!.path).toEqual(["LPToken"]);
    expect(abi.records[0]!.fields).toHaveLength(3);

    // Mappings — struct ref preserves full identity
    expect(abi.mappings).toHaveLength(2);
    expect(abi.mappings[0]!.value).toEqual({
      Struct: { path: ["Pair"], program: null },
    });

    // Storage variables — StorageType preserved
    expect(abi.storage_variables).toHaveLength(1);
    expect(abi.storage_variables[0]!.ty).toEqual({
      Plaintext: { Primitive: "Address" },
    });

    // Functions — normalized
    expect(abi.transitions).toHaveLength(3);

    // add_liquidity: is_final=true → is_async=true, Record ref preserved, Final → Future
    const addLiq = abi.transitions[0]!;
    expect(addLiq.name).toBe("add_liquidity");
    expect(addLiq.is_async).toBe(true);
    expect(addLiq.inputs).toHaveLength(3);
    expect(addLiq.outputs).toHaveLength(2);
    expect(addLiq.outputs[0]!.ty).toEqual({
      Record: { path: ["LPToken"], program: "dex.aleo" },
    });
    expect(addLiq.outputs[1]!.ty).toEqual({ Future: "dex.aleo" });

    // remove_liquidity: Record input preserved
    const removeLiq = abi.transitions[1]!;
    expect(removeLiq.inputs[0]!.ty).toEqual({
      Record: { path: ["LPToken"], program: "dex.aleo" },
    });

    // swap: sync function
    const swap = abi.transitions[2]!;
    expect(swap.is_async).toBe(false);
    expect(swap.outputs[0]!.ty).toEqual({ Plaintext: { Primitive: { UInt: "U128" } } });
  });
});

// ---------------------------------------------------------------------------
// Real fixture files from examples/
// ---------------------------------------------------------------------------

describe("parseAbi — fixture files", () => {
  it("parses hello.abi.json fixture", () => {
    const json = readFileSync(resolve(FIXTURES_DIR, "hello.abi.json"), "utf-8");
    const abi = parseAbi(json);

    expect(abi.program).toBe("hello.aleo");
    expect(abi.structs).toHaveLength(0);
    expect(abi.records).toHaveLength(0);
    expect(abi.mappings).toHaveLength(0);
    expect(abi.storage_variables).toHaveLength(0);
    expect(abi.transitions).toHaveLength(2);

    const main = abi.transitions[0]!;
    expect(main.name).toBe("main");
    expect(main.is_async).toBe(false);
    expect(main.inputs).toHaveLength(2);
    expect(main.inputs[0]!.name).toBe("a");
    expect(main.inputs[0]!.ty).toEqual({ Plaintext: { Primitive: { UInt: "U32" } } });
    expect(main.inputs[0]!.mode).toBe("None");
    expect(main.outputs).toHaveLength(1);
    expect(main.outputs[0]!.ty).toEqual({ Plaintext: { Primitive: { UInt: "U32" } } });

    const multiply = abi.transitions[1]!;
    expect(multiply.name).toBe("multiply");
    expect(multiply.is_async).toBe(false);
  });

  it("parses token.abi.json fixture", () => {
    const json = readFileSync(resolve(FIXTURES_DIR, "token.abi.json"), "utf-8");
    const abi = parseAbi(json);

    expect(abi.program).toBe("token.aleo");
    expect(abi.structs).toHaveLength(0);

    // Record — path preserved
    expect(abi.records).toHaveLength(1);
    expect(abi.records[0]!.path).toEqual(["Token"]);
    expect(abi.records[0]!.fields).toHaveLength(2);
    expect(abi.records[0]!.fields[0]!.name).toBe("owner");
    expect(abi.records[0]!.fields[0]!.ty).toEqual({ Primitive: "Address" });

    // Mapping
    expect(abi.mappings).toHaveLength(1);
    expect(abi.mappings[0]!.name).toBe("balances");
    expect(abi.mappings[0]!.key).toEqual({ Primitive: "Address" });
    expect(abi.mappings[0]!.value).toEqual({ Primitive: { UInt: "U64" } });

    // Functions — 4 total
    expect(abi.transitions).toHaveLength(4);

    // mint_public: async (is_final=true → is_async=true), Final → Future
    const mintPublic = abi.transitions[0]!;
    expect(mintPublic.name).toBe("mint_public");
    expect(mintPublic.is_async).toBe(true);
    expect(mintPublic.inputs[0]!.mode).toBe("Public");
    expect(mintPublic.outputs[0]!.ty).toEqual({ Future: "token.aleo" });

    // mint_private: sync, returns Record with preserved ref
    const mintPrivate = abi.transitions[2]!;
    expect(mintPrivate.name).toBe("mint_private");
    expect(mintPrivate.is_async).toBe(false);
    expect(mintPrivate.outputs[0]!.ty).toEqual({
      Record: { path: ["Token"], program: "token.aleo" },
    });

    // transfer_private: takes Record input, returns two Records
    const transferPrivate = abi.transitions[3]!;
    expect(transferPrivate.name).toBe("transfer_private");
    expect(transferPrivate.inputs[0]!.ty).toEqual({
      Record: { path: ["Token"], program: "token.aleo" },
    });
    expect(transferPrivate.outputs).toHaveLength(2);
    expect(transferPrivate.outputs[0]!.ty).toEqual({
      Record: { path: ["Token"], program: "token.aleo" },
    });
    expect(transferPrivate.outputs[1]!.ty).toEqual({
      Record: { path: ["Token"], program: "token.aleo" },
    });
  });

  it("parses rewards.abi.json fixture", () => {
    const json = readFileSync(resolve(FIXTURES_DIR, "rewards.abi.json"), "utf-8");
    const abi = parseAbi(json);

    expect(abi.program).toBe("rewards.aleo");
    expect(abi.mappings).toHaveLength(2);

    // Boolean mapping value
    const claimed = abi.mappings[1]!;
    expect(claimed.name).toBe("claimed");
    expect(claimed.value).toEqual({ Primitive: "Boolean" });

    // All functions are async
    expect(abi.transitions).toHaveLength(2);
    expect(abi.transitions[0]!.is_async).toBe(true);
    expect(abi.transitions[1]!.is_async).toBe(true);
    expect(abi.transitions[0]!.outputs[0]!.ty).toEqual({ Future: "rewards.aleo" });
  });

  it("parses treasury.abi.json fixture", () => {
    const json = readFileSync(resolve(FIXTURES_DIR, "treasury.abi.json"), "utf-8");
    const abi = parseAbi(json);

    expect(abi.program).toBe("treasury.aleo");
    expect(abi.mappings).toHaveLength(1);
    expect(abi.transitions).toHaveLength(2);
    expect(abi.transitions[0]!.name).toBe("deposit");
    expect(abi.transitions[1]!.name).toBe("withdraw");
  });
});
