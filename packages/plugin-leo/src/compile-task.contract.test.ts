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
import { afterEach, describe, expect, it, vi } from "vitest";
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
                fields: [{ name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "None" }],
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
      (abi: {
        program: string;
        structs?: { path: string[] }[];
        records?: { path: string[] }[];
      }) => {
        const base = abi.program
          .replace(/\.aleo$/, "")
          .split(/[_\-.]/)
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join("");
        const typeNames = new Set([
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

  afterEach(() => {
    result?.cleanup();
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

  it("compile task passes options to compilePipeline", async () => {
    const lre = createTestLre();
    await lre.tasks.run("compile", { force: true, program: "hello" });

    const { compilePipeline } = await import("@lionden/leo-compiler");
    expect(compilePipeline).toHaveBeenCalledWith(
      lre.config,
      expect.objectContaining({ force: true, program: "hello" }),
    );
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

    // Barrel export
    const indexContent = fs.readFileSync(path.join(typechainDir, "index.ts"), "utf-8");
    expect(indexContent).toContain("BaseContract");
    expect(indexContent).toContain("Hello");
    expect(indexContent).toContain("Token");
  });

  it("omits duplicate record helper exports from the typechain barrel", async () => {
    const { compilePipeline } = await import("@lionden/leo-compiler");
    vi.mocked(compilePipeline).mockResolvedValueOnce({
      results: ["gold_token", "silver_token"].map((name) => ({
        unit: {
          kind: "program" as const,
          programId: `${name}.aleo`,
          sourceDir: `/tmp/test/programs/${name}`,
          entryFile: `/tmp/test/programs/${name}/main.leo`,
          allSources: ["main.leo"],
        },
        cached: false,
        packageDir: `/tmp/test/.cache/${name}`,
        buildDir: `/tmp/test/.cache/${name}/build`,
        abi: {
          program: `${name}.aleo`,
          structs: [],
          records: [
            {
              path: ["Token"],
              fields: [{ name: "amount", ty: { Primitive: { UInt: "U64" } }, mode: "None" }],
            },
          ],
          mappings: [],
          storage_variables: [],
          transitions: [],
        },
        aleoSource: "",
      })),
    } as any);

    const lre = createTestLre(true);
    await lre.tasks.run("compile");

    const indexContent = fs.readFileSync(
      path.join(lre.config.paths.typechain, "index.ts"),
      "utf-8",
    );
    expect(indexContent).toContain(
      "Omitted duplicate exports: Token, decryptToken, deserializeToken, serializeToken.",
    );
    expect(indexContent).not.toContain("export type { Token }");
    expect(indexContent).toContain("export { GoldToken, createGoldToken }");
    expect(indexContent).toContain("export { SilverToken, createSilverToken }");
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
});
