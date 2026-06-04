/**
 * Unit tests for `resolveDynamicRecordHelpers` — exercises ambiguous source
 * records and module-scoped record disambiguation that the contract-level
 * compile-task tests don't cover cleanly because of their shared `vi.mock`
 * setup.
 */

import type { LionDenResolvedConfig } from "@lionden/config";
import { describe, expect, it } from "vitest";
import { resolveDynamicRecordHelpers } from "./index.js";

function lreWith(
  dynamicRecords: Record<
    string,
    {
      helperName: string;
      sourceRecord: string;
      sourceProgram?: string;
      schema: Record<string, string>;
    }
  >,
): { readonly config: LionDenResolvedConfig } {
  return {
    config: {
      codegen: { dynamicRecords },
    } as unknown as LionDenResolvedConfig,
  };
}

function programResult(programId: string, recordPaths: readonly (readonly string[])[]) {
  return {
    unit: { kind: "program", programId } as const,
    abi: {
      program: programId,
      records: recordPaths.map((path) => ({ path, fields: [] })),
      structs: [],
      mappings: [],
      storage_variables: [],
      transitions: [],
    },
  } as any;
}

describe("resolveDynamicRecordHelpers", () => {
  it("returns empty map when no helpers are configured", () => {
    const result = resolveDynamicRecordHelpers(lreWith({}), [
      programResult("token.aleo", [["Token"]]),
    ]);
    expect(result.size).toBe(0);
  });

  it("throws CodegenError when sourceRecord matches no compiled program", () => {
    expect(() =>
      resolveDynamicRecordHelpers(
        lreWith({
          asMissing: {
            helperName: "asMissing",
            sourceRecord: "Ghost",
            schema: { owner: "address.private" },
          },
        }),
        [programResult("token.aleo", [["Token"]])],
      ),
    ).toThrow(/'Ghost' does not match any local record/);
  });

  it("throws CodegenError on ambiguous sourceRecord when sourceProgram is omitted", () => {
    let err: any;
    try {
      resolveDynamicRecordHelpers(
        lreWith({
          asPoolToken: {
            helperName: "asPoolToken",
            sourceRecord: "Token",
            schema: { owner: "address.private" },
          },
        }),
        [
          programResult("stable_token.aleo", [["Token"]]),
          programResult("volatile_token.aleo", [["Token"]]),
        ],
      );
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe("CodegenError");
    expect(err.message).toContain("ambiguous");
    expect(err.message).toContain("stable_token.aleo");
    expect(err.message).toContain("volatile_token.aleo");
    expect(err.context).toMatchObject({
      candidates: expect.arrayContaining(["stable_token.aleo", "volatile_token.aleo"]),
    });
  });

  it("disambiguates ambiguous sourceRecord when sourceProgram is provided", () => {
    const result = resolveDynamicRecordHelpers(
      lreWith({
        asPoolToken: {
          helperName: "asPoolToken",
          sourceRecord: "Token",
          sourceProgram: "stable_token.aleo",
          schema: { owner: "address.private" },
        },
      }),
      [
        programResult("stable_token.aleo", [["Token"]]),
        programResult("volatile_token.aleo", [["Token"]]),
      ],
    );
    expect([...result.keys()]).toEqual(["stable_token.aleo"]);
    expect(result.get("stable_token.aleo")![0]!.helperName).toBe("asPoolToken");
  });

  it("treats module-scoped Foo_Bar_Token as distinct from a plain Token", () => {
    // Plain `Token` in stable_token; module-scoped `foo::bar::Token` (generated
    // name `Foo_Bar_Token`) in modular.aleo. Routing must not see these as the
    // same record.
    const result = resolveDynamicRecordHelpers(
      lreWith({
        asPoolToken: {
          helperName: "asPoolToken",
          sourceRecord: "Token",
          schema: { owner: "address.private" },
        },
        asModularToken: {
          helperName: "asModularToken",
          sourceRecord: "Foo_Bar_Token",
          schema: { owner: "address.private" },
        },
      }),
      [
        programResult("stable_token.aleo", [["Token"]]),
        programResult("modular.aleo", [["Foo", "Bar", "Token"]]),
      ],
    );
    expect([...result.keys()].sort()).toEqual(["modular.aleo", "stable_token.aleo"]);
    expect(result.get("stable_token.aleo")![0]!.helperName).toBe("asPoolToken");
    expect(result.get("modular.aleo")![0]!.helperName).toBe("asModularToken");
  });
});
