import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProgramABI } from "./abi-types.js";
import { computeAbiHash } from "./abi-hash.js";

const LEGACY_ABI: ProgramABI = {
  program: "plain.aleo",
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
    },
  ],
};

function oldHash(abi: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(abi)).digest("hex");
}

describe("computeAbiHash", () => {
  it("preserves the legacy hash when new ABI extension fields are empty", () => {
    const withEmptyExtensions: ProgramABI = {
      ...LEGACY_ABI,
      transitions: [{ ...LEGACY_ABI.transitions[0]!, const_parameters: [] }],
      views: [],
      implements: [],
    };

    expect(computeAbiHash(withEmptyExtensions)).toBe(oldHash(LEGACY_ABI));
  });

  it("normalizes compiler-format functions before hashing", () => {
    const compilerFormat = {
      program: "plain.aleo",
      structs: [],
      records: [],
      mappings: [],
      storage_variables: [],
      functions: [
        {
          name: "main",
          is_final: false,
          inputs: [],
          outputs: [],
        },
      ],
    };

    expect(computeAbiHash(compilerFormat as unknown as ProgramABI)).toBe(oldHash(LEGACY_ABI));
  });

  it("includes materially present Leo 4.1 ABI fields", () => {
    const withView: ProgramABI = {
      ...LEGACY_ABI,
      views: [
        {
          name: "get",
          inputs: [],
          outputs: [
            { ty: { Plaintext: { Primitive: { UInt: "U64" } } }, mode: "Public" },
          ],
        },
      ],
    };

    expect(computeAbiHash(withView)).not.toBe(oldHash(LEGACY_ABI));
  });

  it("includes executable const parameters when present", () => {
    const withConstParams: ProgramABI = {
      ...LEGACY_ABI,
      transitions: [
        {
          ...LEGACY_ABI.transitions[0]!,
          const_parameters: [{ name: "N", type: "u8" }],
        },
      ],
    };

    expect(computeAbiHash(withConstParams)).not.toBe(oldHash(LEGACY_ABI));
  });
});
