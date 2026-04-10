/**
 * Tier 2 contract test — crosses: @lionden/plugin-leo + @lionden/core + @lionden/leo-compiler
 *
 * Tests the compile task end-to-end: task dispatch through plugin-leo calls
 * leo-compiler's compilePipeline(), populates lre.artifacts, and generates
 * TypeScript bindings.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createContractLre, type ContractLreResult } from "@lionden/test-internals";
import pluginLeo from "./index.js";

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
            records: [{ name: "Token", fields: [{ name: "amount", type: "u64" }] }],
            mappings: [{ name: "balances", keyType: "address", valueType: "u64" }],
          },
          aleoSource: "",
        },
      ],
    }),
    generateBindings: vi.fn().mockReturnValue("// generated bindings\n"),
    generateBaseContract: vi.fn().mockReturnValue("// base contract\n"),
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
        codegen: { enabled: codegenEnabled, outDir: "typechain" },
      },
    });
    return result.lre;
  }

  it("compile task calls compilePipeline and populates artifacts", async () => {
    const lre = createTestLre();
    await lre.tasks.run("compile");

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
