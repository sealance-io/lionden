import { describe, it, expect } from "vitest";
import { primitiveToTs, plaintextToTs, aleoTypeToTs, primitiveToLeoSuffix, isBigIntType } from "./type-mapper.js";

describe("primitiveToTs", () => {
  it("maps string primitives", () => {
    expect(primitiveToTs("Address")).toBe("string");
    expect(primitiveToTs("Boolean")).toBe("boolean");
    expect(primitiveToTs("Field")).toBe("string");
    expect(primitiveToTs("Group")).toBe("string");
    expect(primitiveToTs("Scalar")).toBe("string");
  });

  it("maps small unsigned ints to number", () => {
    expect(primitiveToTs({ UInt: "U8" })).toBe("number");
    expect(primitiveToTs({ UInt: "U16" })).toBe("number");
    expect(primitiveToTs({ UInt: "U32" })).toBe("number");
  });

  it("maps large unsigned ints to bigint", () => {
    expect(primitiveToTs({ UInt: "U64" })).toBe("bigint");
    expect(primitiveToTs({ UInt: "U128" })).toBe("bigint");
  });

  it("maps signed ints", () => {
    expect(primitiveToTs({ Int: "I8" })).toBe("number");
    expect(primitiveToTs({ Int: "I32" })).toBe("number");
    expect(primitiveToTs({ Int: "I64" })).toBe("bigint");
    expect(primitiveToTs({ Int: "I128" })).toBe("bigint");
  });
});

describe("plaintextToTs", () => {
  it("maps primitives", () => {
    expect(plaintextToTs({ Primitive: "Address" })).toBe("string");
    expect(plaintextToTs({ Primitive: { UInt: "U64" } })).toBe("bigint");
  });

  it("maps structs to their name", () => {
    expect(plaintextToTs({ Struct: "TokenInfo" })).toBe("TokenInfo");
  });

  it("maps arrays", () => {
    expect(plaintextToTs({ Array: [{ Primitive: { UInt: "U32" } }, 5] })).toBe("number[]");
  });
});

describe("aleoTypeToTs", () => {
  it("maps Plaintext types", () => {
    expect(aleoTypeToTs({ Plaintext: { Primitive: "Boolean" } })).toBe("boolean");
  });

  it("maps Record types to their name", () => {
    expect(aleoTypeToTs({ Record: "Token" })).toBe("Token");
  });

  it("maps Future to void", () => {
    expect(aleoTypeToTs({ Future: "transfer" })).toBe("void");
  });
});

describe("primitiveToLeoSuffix", () => {
  it("returns correct suffixes", () => {
    expect(primitiveToLeoSuffix("Address")).toBe("address");
    expect(primitiveToLeoSuffix("Boolean")).toBe("bool");
    expect(primitiveToLeoSuffix("Field")).toBe("field");
    expect(primitiveToLeoSuffix({ UInt: "U64" })).toBe("u64");
    expect(primitiveToLeoSuffix({ Int: "I32" })).toBe("i32");
  });
});

describe("isBigIntType", () => {
  it("identifies bigint types", () => {
    expect(isBigIntType({ UInt: "U64" })).toBe(true);
    expect(isBigIntType({ UInt: "U128" })).toBe(true);
    expect(isBigIntType({ Int: "I64" })).toBe(true);
    expect(isBigIntType({ UInt: "U32" })).toBe(false);
    expect(isBigIntType("Address")).toBe(false);
  });
});
