/**
 * Tier 2 contract test — crosses: @lionden/plugin-leo + @lionden/core + @lionden/leo-compiler
 *
 * Tests the compile task end-to-end: task dispatch through plugin-leo calls
 * leo-compiler's compilePipeline(), populates lre.artifacts, and generates
 * TypeScript bindings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pluginLeo from "./index.js";

vi.mock("@lionden/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/core")>();
  return {
    ...original,
    preflightLeo: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock leo-compiler's pipeline to avoid real Leo CLI invocation
vi.mock("@lionden/leo-compiler", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/leo-compiler")>();
  return {
    ...original,
    compilePipeline: vi.fn().mockResolvedValue({
      results: [
        {
          unit: {
            kind: "program",
            programId: "hello.aleo",
            sourceDir: "/tmp/test/programs/hello",
            entryFile: "/tmp/test/programs/hello/main.leo",
            allSources: ["main.leo"],
          },
          cached: false,
          packageDir: "/tmp/test/.cache/hello",
          buildDir: "/tmp/test/.cache/hello/build",
          abi: {
            program: "hello.aleo",
            version: "1.0.0",
            functions: [
              {
                name: "main",
                inputs: [{ type: "u32", visibility: "private" }],
                outputs: [{ type: "u32", visibility: "private" }],
              },
            ],
            structs: [],
            records: [],
            mappings: [],
          },
          aleoSource: "",
        },
        {
          unit: {
            kind: "program",
            programId: "token.aleo",
            sourceDir: "/tmp/test/programs/token",
            entryFile: "/tmp/test/programs/token/main.leo",
            allSources: ["main.leo"],
          },
          cached: false,
          packageDir: "/tmp/test/.cache/token",
          buildDir: "/tmp/test/.cache/token/build",
          abi: {
            program: "token.aleo",
            version: "1.0.0",
            functions: [
              {
                name: "mint",
                inputs: [
                  { type: "address", visibility: "private" },
                  { type: "u64", visibility: "private" },
                ],
                outputs: [{ type: "token.aleo/Token", visibility: "record" }],
              },
            ],
            structs: [],
            records: [
              {
                path: ["Token"],
                fields: [{ name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "Private" }],
              },
            ],
            mappings: [{ name: "balances", keyType: "address", valueType: "u64" }],
          },
          aleoSource: "",
        },
      ],
    }),
    generateBindings: vi.fn().mockReturnValue("// generated bindings\n"),
    generateBaseContract: vi.fn().mockReturnValue("// base contract\n"),
    resolveContractClassName: vi.fn(
      (
        abi: {
          program: string;
          structs?: { path: string[] }[];
          records?: { path: string[] }[];
        },
        options?: { includeLeoValueImport?: boolean },
      ) => {
        const base = abi.program
          .replace(/\.aleo$/, "")
          .split(/[_\-.]/)
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join("");
        const typeNames = new Set([
          // Faithful to the real impl: when the module value-imports `Leo`
          // (i.e. it emits dynamic-record helpers) the class name must also bump
          // away from the fixed value imports.
          ...(options?.includeLeoValueImport
            ? ["BaseContract", "Leo", "createRecordOutputMatcher"]
            : []),
          ...(abi.structs ?? []).map((s) => s.path.join("_")),
          ...(abi.records ?? []).map((r) => r.path.join("_")),
        ]);
        let candidate = base;
        while (typeNames.has(candidate)) candidate += "Contract";
        return candidate;
      },
    ),
  };
});

describe("compile task contract", () => {
  let result: ContractLreResult;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    result?.cleanup();
    vi.restoreAllMocks();
    if (originalNoColor === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = originalNoColor;
    }
  });

  function createTestLre(codegenEnabled = true) {
    result = createContractLre({
      plugins: [pluginLeo],
      configOverrides: {
        codegen: { enabled: codegenEnabled, outDir: "typechain", dynamicRecords: {} },
      },
    });
    return result.lre;
  }

  it("compile task calls compilePipeline and populates artifacts", async () => {
    const lre = createTestLre();
    await lre.tasks.run("compile");

    const { preflightLeo } = await import("@lionden/core");
    expect(preflightLeo).toHaveBeenCalledWith(lre.config);

    // Cross-package: compile task in plugin-leo populates lre.artifacts (from core)
    expect(lre.artifacts.getAbi("hello.aleo")).toBeDefined();
    expect(lre.artifacts.getAbi("token.aleo")).toBeDefined();
    expect(lre.artifacts.getProgramIds()).toContain("hello.aleo");
    expect(lre.artifacts.getProgramIds()).toContain("token.aleo");
  });

  it("logs full-scope compile start before preflight and compilation", async () => {
    const { compilePipeline } = await import("@lionden/leo-compiler");
    const { preflightLeo } = await import("@lionden/core");
    vi.mocked(compilePipeline).mockClear();
    vi.mocked(preflightLeo).mockClear();
    const lre = createTestLre();

    await lre.tasks.run("compile");

    expect(vi.mocked(console.log).mock.calls.map(([message]) => String(message))).toContain(
      "Compiling programs",
    );
    expect(vi.mocked(console.log).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(preflightLeo).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(console.log).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(compilePipeline).mock.invocationCallOrder[0]!,
    );
  });

  it("logs targeted compile start with the concrete program option", async () => {
    const lre = createTestLre();

    await lre.tasks.run("compile", { program: "token_registry.aleo" });

    expect(vi.mocked(console.log).mock.calls.map(([message]) => String(message))).toContain(
      "Compiling token_registry.aleo",
    );
  });

  it("logs single-program compile completion with the concrete program id", async () => {
    const { compilePipeline } = await import("@lionden/leo-compiler");
    vi.mocked(compilePipeline).mockResolvedValueOnce({
      results: [
        {
          unit: {
            kind: "program" as const,
            programId: "token_registry.aleo",
            sourceDir: "/tmp/test/programs/token_registry",
            entryFile: "/tmp/test/programs/token_registry/main.leo",
            allSources: ["main.leo"],
          },
          cached: false,
          packageDir: "/tmp/test/.cache/token_registry",
          buildDir: "/tmp/test/.cache/token_registry/build",
          abi: {
            program: "token_registry.aleo",
            version: "1.0.0",
            functions: [],
            structs: [],
            records: [],
            mappings: [],
          },
          aleoSource: "",
        },
      ],
    } as any);
    const lre = createTestLre();

    await lre.tasks.run("compile");

    const logs = vi.mocked(console.log).mock.calls.map(([message]) => String(message));
    expect(logs).toContain("Compiled token_registry.aleo and generated typechain bindings");
    expect(logs.join("\n")).not.toContain("[object Object]");
    expect(logs.join("\n")).not.toContain("undefined");
  });

  it("logs multi-program compile completion with the program count", async () => {
    const lre = createTestLre();

    await lre.tasks.run("compile");

    expect(vi.mocked(console.log).mock.calls.map(([message]) => String(message))).toContain(
      "Compiled 2 programs and generated typechain bindings",
    );
  });

  it("logs library-only compile completion without saying 0 programs", async () => {
    const { compilePipeline } = await import("@lionden/leo-compiler");
    vi.mocked(compilePipeline).mockResolvedValueOnce({
      results: [
        {
          unit: {
            kind: "library" as const,
            name: "math_utils",
            sourceDir: "/tmp/test/programs/math_utils",
            entryFile: "/tmp/test/programs/math_utils/lib.leo",
            allSources: ["lib.leo"],
          },
          cached: false,
          packageDir: "/tmp/test/.cache/math_utils",
          buildDir: "/tmp/test/.cache/math_utils/build",
        },
      ],
    } as any);
    const lre = createTestLre();

    await lre.tasks.run("compile");

    const logs = vi.mocked(console.log).mock.calls.map(([message]) => String(message));
    expect(logs).toContain("Compiled library math_utils and generated typechain bindings");
    expect(logs.join("\n")).not.toContain("Compiled 0 programs");
  });

  it("compile task passes options to compilePipeline", async () => {
    const lre = createTestLre();
    await lre.tasks.run("compile", { force: true, program: "hello" });

    const { compilePipeline } = await import("@lionden/leo-compiler");
    expect(compilePipeline).toHaveBeenCalledWith(
      lre.config,
      expect.objectContaining({ force: true, program: "hello" }),
    );
  });

  it("forwards a passthrough network arg into compilePipeline options", async () => {
    const lre = createTestLre();
    await lre.tasks.run("compile", { network: "testnet" });

    const { compilePipeline } = await import("@lionden/leo-compiler");
    expect(compilePipeline).toHaveBeenCalledWith(
      lre.config,
      expect.objectContaining({ network: "testnet" }),
    );
  });

  it("leaves network undefined in compilePipeline options on a default run", async () => {
    const { compilePipeline } = await import("@lionden/leo-compiler");
    vi.mocked(compilePipeline).mockClear();

    const lre = createTestLre();
    await lre.tasks.run("compile");

    const lastCall = vi.mocked(compilePipeline).mock.calls.at(-1)!;
    expect((lastCall[1] as { network?: string }).network).toBeUndefined();
  });

  it("generates TypeScript bindings when codegen is enabled", async () => {
    const lre = createTestLre(true);
    await lre.tasks.run("compile");

    const typechainDir = lre.config.paths.typechain;

    // BaseContract.ts should be written
    expect(fs.existsSync(path.join(typechainDir, "BaseContract.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(typechainDir, "BaseContract.ts"), "utf-8")).toBe(
      "// base contract\n",
    );

    // Per-program bindings (PascalCase class names)
    expect(fs.existsSync(path.join(typechainDir, "Hello.ts"))).toBe(true);
    expect(fs.existsSync(path.join(typechainDir, "Token.ts"))).toBe(true);
    expect(fs.existsSync(path.join(typechainDir, "index.ts"))).toBe(false);
  });

  it("skips TypeScript bindings when --noTypechain is set", async () => {
    const lre = createTestLre(true);
    await lre.tasks.run("compile", { noTypechain: true });

    const typechainDir = lre.config.paths.typechain;
    expect(fs.existsSync(typechainDir)).toBe(false);
  });

  it("skips TypeScript bindings when codegen is disabled", async () => {
    const lre = createTestLre(false);
    await lre.tasks.run("compile");

    const typechainDir = lre.config.paths.typechain;
    expect(fs.existsSync(typechainDir)).toBe(false);
  });

  it("calls generateBindings for each compiled program", async () => {
    const { generateBindings } = await import("@lionden/leo-compiler");
    (generateBindings as ReturnType<typeof vi.fn>).mockClear();

    const lre = createTestLre(true);
    await lre.tasks.run("compile");

    // Should be called once per program (2 programs in mock)
    expect(generateBindings).toHaveBeenCalledTimes(2);
  });
});

describe("dynamicRecords routing", () => {
  let result: ContractLreResult;

  afterEach(() => {
    result?.cleanup();
  });

  async function runWithHelpers(
    dynamicRecords: Record<string, unknown>,
  ): Promise<{ generateBindings: ReturnType<typeof vi.fn>; error: Error | null }> {
    const { generateBindings } = await import("@lionden/leo-compiler");
    (generateBindings as ReturnType<typeof vi.fn>).mockClear();
    result = createContractLre({
      plugins: [pluginLeo],
      configOverrides: {
        codegen: { enabled: true, outDir: "typechain", dynamicRecords: dynamicRecords as any },
      },
    });
    let error: Error | null = null;
    try {
      await result.lre.tasks.run("compile");
    } catch (e) {
      error = e as Error;
    }
    return { generateBindings: generateBindings as ReturnType<typeof vi.fn>, error };
  }

  it("routes a helper to the program owning the sourceRecord", async () => {
    const { generateBindings, error } = await runWithHelpers({
      asPoolToken: {
        helperName: "asPoolToken",
        sourceRecord: "Token",
        schema: { amount: "u64.private" },
      },
    });
    expect(error).toBeNull();
    // token.aleo owns Token; hello.aleo has no records.
    const tokenCall = generateBindings.mock.calls.find(
      (call) => (call[0] as { program: string }).program === "token.aleo",
    );
    const helloCall = generateBindings.mock.calls.find(
      (call) => (call[0] as { program: string }).program === "hello.aleo",
    );
    expect(tokenCall?.[2]).toEqual({
      dynamicRecords: [
        {
          helperName: "asPoolToken",
          sourceRecord: "Token",
          sourceProgram: "token.aleo",
          schema: { amount: "u64.private" },
        },
      ],
    });
    expect(helloCall?.[2]).toEqual({});
  });

  it("throws CodegenError when sourceRecord matches no compiled program", async () => {
    const { error } = await runWithHelpers({
      asMissing: {
        helperName: "asMissing",
        sourceRecord: "NonExistent",
        schema: { amount: "u64.private" },
      },
    });
    expect(error?.name).toBe("CodegenError");
    expect(error?.message).toContain("'NonExistent' does not match any local record");
  });

  it("throws CodegenError on sourceProgram mismatch", async () => {
    const { error } = await runWithHelpers({
      asPoolToken: {
        helperName: "asPoolToken",
        sourceRecord: "Token",
        sourceProgram: "hello.aleo",
        schema: { amount: "u64.private" },
      },
    });
    expect(error?.name).toBe("CodegenError");
    expect(error?.message).toContain("'hello.aleo' does not declare record 'Token'");
  });

  it("throws CodegenError on sourceProgram typo during full compile", async () => {
    const { error } = await runWithHelpers({
      asPoolToken: {
        helperName: "asPoolToken",
        sourceRecord: "Token",
        sourceProgram: "gold_token_typo.aleo",
        schema: { amount: "u64.private" },
      },
    });
    expect(error?.name).toBe("CodegenError");
    expect(error?.message).toContain("'gold_token_typo.aleo' does not declare record 'Token'");
  });

  it("skips dynamic-record helpers scoped outside a targeted compile subset", async () => {
    const { compilePipeline, generateBindings } = await import("@lionden/leo-compiler");
    vi.mocked(compilePipeline).mockResolvedValueOnce({
      results: [
        {
          unit: {
            kind: "program" as const,
            programId: "merkle_tree.aleo",
            sourceDir: "/tmp/test/programs/merkle_tree",
            entryFile: "/tmp/test/programs/merkle_tree/main.leo",
            allSources: ["main.leo"],
          },
          cached: false,
          packageDir: "/tmp/test/.cache/merkle_tree",
          buildDir: "/tmp/test/.cache/merkle_tree/build",
          abi: {
            program: "merkle_tree.aleo",
            structs: [],
            records: [
              {
                path: ["Leaf"],
                fields: [{ name: "value", ty: { Primitive: "Field" }, mode: "Private" }],
              },
            ],
            mappings: [],
            storage_variables: [],
            transitions: [],
          },
          aleoSource: "",
        },
      ],
    } as any);
    (generateBindings as ReturnType<typeof vi.fn>).mockClear();

    result = createContractLre({
      plugins: [pluginLeo],
      configOverrides: {
        codegen: {
          enabled: true,
          outDir: "typechain",
          dynamicRecords: {
            asGoldToken: {
              helperName: "asGoldToken",
              sourceProgram: "gold_token.aleo",
              sourceRecord: "Token",
              schema: { amount: "u64.private" },
            },
          },
        },
      },
    });

    await result.lre.tasks.run("compile", { program: "merkle_tree" });

    expect(compilePipeline).toHaveBeenCalledWith(
      result.lre.config,
      expect.objectContaining({ program: "merkle_tree" }),
    );
    expect(generateBindings).toHaveBeenCalledTimes(1);
    expect(generateBindings).toHaveBeenCalledWith(
      expect.objectContaining({ program: "merkle_tree.aleo" }),
      [expect.objectContaining({ program: "merkle_tree.aleo" })],
      {},
    );
  });
});
