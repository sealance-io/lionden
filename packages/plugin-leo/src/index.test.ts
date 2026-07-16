import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ConfigHookHandlers, createLre } from "@lionden/core";
import { createMockConfig } from "@lionden/test-internals";
import { afterEach, describe, expect, it, vi } from "vitest";
import pluginLeo from "./index.js";

function programResult(
  programId: string,
  options: {
    readonly sourceProgramId?: string;
    readonly records?: readonly (readonly string[])[];
  } = {},
) {
  return {
    unit: { kind: "program", programId } as const,
    sourceProgramId: options.sourceProgramId ?? programId,
    programId,
    abi: {
      program: options.sourceProgramId ?? programId,
      structs: [],
      records: (options.records ?? []).map((recordPath) => ({ path: recordPath, fields: [] })),
      mappings: [],
      storage_variables: [],
      transitions: [],
    },
  } as any;
}

describe("plugin-leo", () => {
  it("has correct plugin id and name", () => {
    expect(pluginLeo.id).toBe("@lionden/plugin-leo");
    expect(pluginLeo.name).toBe("Leo Compiler Plugin");
  });

  it("registers compile and clean tasks", () => {
    const taskIds = pluginLeo.tasks?.map((t) => t.id) ?? [];
    expect(taskIds).toContain("compile");
    expect(taskIds).toContain("clean");
  });

  it("has config hook handlers", () => {
    expect(pluginLeo.hookHandlers).toBeDefined();
    expect(pluginLeo.hookHandlers!.config).toBeDefined();
  });

  it("compile task has force/noTypechain flags and program option", () => {
    const compileTask = pluginLeo.tasks?.find((t) => t.id === "compile");
    expect(compileTask).toBeDefined();

    const optionNames = compileTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("program");

    const flagNames = compileTask!.flags?.map((f) => f.name) ?? [];
    expect(flagNames).toContain("force");
    expect(flagNames).toContain("noTypechain");
  });

  it("tasks are registered in LRE", () => {
    const config = createMockConfig();
    const lre = createLre({ config, plugins: [pluginLeo] });

    expect(lre.tasks.has("compile")).toBe(true);
    expect(lre.tasks.has("clean")).toBe(true);
  });
});

describe("config validation hooks", () => {
  // Cast to concrete type — plugin-leo uses a direct object, not a lazy loader
  const configHooks = pluginLeo.hookHandlers!.config as ConfigHookHandlers;
  const validateUser = configHooks.validateUserConfig! as (
    config: unknown,
  ) => { path: string; message: string }[];
  const validateResolved = configHooks.validateResolvedConfig! as (
    config: unknown,
  ) => { path: string; message: string }[];

  it("accepts supported Leo patch lines", () => {
    for (const leoVersion of [
      "4.3.0",
      "4.3.1",
      "4.3.2",
      "4.2.0",
      "4.2.1",
      "4.1.0",
      "4.1.1",
      "4.0.0",
      "4.0.1",
      "4.0.2",
      "3.5.0",
      "3.5.1",
    ]) {
      expect(validateUser({ leoVersion })).toHaveLength(0);
    }
  });

  it("rejects unsupported or malformed Leo versions", () => {
    const rejected = [
      "4.0",
      "4.0.0-rc1",
      "4.0.0+build",
      "^4.0.0",
      " 4.0.0",
      "4.0.0 ",
      "3.4.0",
      "4.4.0",
      "5.0.0",
      "not-a-version",
    ];

    for (const leoVersion of rejected) {
      const errors = validateUser({ leoVersion });
      expect(errors.length, leoVersion).toBeGreaterThan(0);
      expect(errors[0]!.path).toBe("leoVersion");
      expect(errors[0]!.message).toContain(leoVersion);
    }
  });

  it("accepts any plain stable version when skipLeoVersionCheck is true", () => {
    const errors = validateUser({
      leoVersion: "5.0.0",
      skipLeoVersionCheck: true,
    });
    expect(errors).toHaveLength(0);
  });

  it("still rejects non-stable versions when skipLeoVersionCheck is true", () => {
    const rejected = ["^5.0.0", " 5.0.0", "5.0.0 ", "5.0.0-rc1", "5.0.0+build", "bad"];

    for (const leoVersion of rejected) {
      const errors = validateUser({ leoVersion, skipLeoVersionCheck: true });
      expect(errors.length, leoVersion).toBeGreaterThan(0);
      expect(errors[0]!.path).toBe("leoVersion");
    }
  });

  it("rejects non-boolean skipLeoVersionCheck", () => {
    const errors = validateUser({ skipLeoVersionCheck: "yes" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.path).toBe("skipLeoVersionCheck");
  });

  it("does not use skip mode when skipLeoVersionCheck is truthy but non-boolean", () => {
    const errors = validateUser({
      leoVersion: "5.0.0",
      skipLeoVersionCheck: "yes",
    });
    expect(errors.map((e) => e.path)).toEqual(["skipLeoVersionCheck", "leoVersion"]);
  });

  it("accepts config with no leoVersion (defaults handled elsewhere)", () => {
    const errors = validateUser({});
    expect(errors).toHaveLength(0);
  });

  it("rejects resolved config when programs dir does not exist", () => {
    const config = createMockConfig({ root: "/nonexistent/path" });
    const errors = validateResolved(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.path).toBe("paths.programs");
  });

  it("passes resolved config when programs dir exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-leo-"));
    const programsDir = path.join(tmpDir, "programs");
    fs.mkdirSync(programsDir);

    try {
      const config = createMockConfig({
        paths: {
          root: tmpDir,
          programs: programsDir,
          artifacts: path.join(tmpDir, "artifacts"),
          typechain: path.join(tmpDir, "typechain"),
          cache: path.join(tmpDir, "cache"),
          deployments: path.join(tmpDir, "deployments"),
        },
      });
      const errors = validateResolved(config);
      expect(errors).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("dynamicRecords config validation", () => {
  const configHooks = pluginLeo.hookHandlers!.config as ConfigHookHandlers;
  const validateUser = configHooks.validateUserConfig! as (
    config: unknown,
  ) => { path: string; message: string }[];

  it("accepts a well-formed dynamicRecords config", () => {
    const errors = validateUser({
      codegen: {
        dynamicRecords: {
          asPoolToken: {
            sourceRecord: "Token",
            schema: {
              owner: "address.private",
              amount: "u128.private",
            },
          },
        },
      },
    });
    expect(errors).toEqual([]);
  });

  it("rejects non-object dynamicRecords map", () => {
    const errors = validateUser({ codegen: { dynamicRecords: [] } });
    expect(errors).toContainEqual({
      path: "codegen.dynamicRecords",
      message: expect.stringContaining("plain object"),
    });
  });

  it("rejects helper names that are not valid TS identifiers", () => {
    const errors = validateUser({
      codegen: {
        dynamicRecords: {
          "as-pool-token": {
            sourceRecord: "Token",
            schema: { owner: "address.private" },
          },
        },
      },
    });
    expect(errors[0]!.path).toBe("codegen.dynamicRecords.as-pool-token");
    expect(errors[0]!.message).toContain("not a valid TypeScript identifier");
  });

  it("rejects non-object helper values", () => {
    const errors = validateUser({
      codegen: {
        dynamicRecords: {
          asPoolToken: "Token",
        },
      },
    });
    expect(errors[0]!.path).toBe("codegen.dynamicRecords.asPoolToken");
  });

  it("rejects missing or non-string sourceRecord", () => {
    const errors = validateUser({
      codegen: {
        dynamicRecords: {
          asPoolToken: { schema: { owner: "address.private" } },
        },
      },
    });
    expect(errors.some((e) => e.path === "codegen.dynamicRecords.asPoolToken.sourceRecord")).toBe(
      true,
    );
  });

  it("rejects sourceProgram not ending in .aleo", () => {
    const errors = validateUser({
      codegen: {
        dynamicRecords: {
          asPoolToken: {
            sourceRecord: "Token",
            sourceProgram: "stable_token",
            schema: { owner: "address.private" },
          },
        },
      },
    });
    expect(errors.some((e) => e.path === "codegen.dynamicRecords.asPoolToken.sourceProgram")).toBe(
      true,
    );
  });

  it("rejects empty schema", () => {
    const errors = validateUser({
      codegen: {
        dynamicRecords: {
          asPoolToken: { sourceRecord: "Token", schema: {} },
        },
      },
    });
    expect(errors.some((e) => e.path === "codegen.dynamicRecords.asPoolToken.schema")).toBe(true);
  });

  it("rejects schema entries that don't match the supported-primitives regex", () => {
    const errors = validateUser({
      codegen: {
        dynamicRecords: {
          asPoolToken: {
            sourceRecord: "Token",
            schema: {
              owner: "address.private",
              bad: "signature.public",
              wrongVisibility: "u8.maybe",
            },
          },
        },
      },
    });
    expect(errors.some((e) => e.path === "codegen.dynamicRecords.asPoolToken.schema.bad")).toBe(
      true,
    );
    expect(
      errors.some((e) => e.path === "codegen.dynamicRecords.asPoolToken.schema.wrongVisibility"),
    ).toBe(true);
  });
});

describe("compile task typechain output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects targeted compile when it would overwrite an unrelated generated module", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-leo-typechain-"));
    const core = await import("@lionden/core");
    const compiler = await import("@lionden/leo-compiler");

    vi.spyOn(core, "preflightLeo").mockResolvedValue(undefined);
    vi.spyOn(compiler, "compilePipeline").mockResolvedValue({
      results: [programResult("foo__bar.aleo")],
    } as any);
    vi.spyOn(compiler, "generateBaseContract").mockReturnValue("// base contract\n");

    try {
      const typechainDir = path.join(tmpDir, "typechain");
      fs.mkdirSync(typechainDir, { recursive: true });
      fs.writeFileSync(path.join(typechainDir, "FooBar.ts"), "// Program: foo_bar.aleo\n");

      const lre = createLre({
        config: createMockConfig({
          paths: {
            root: tmpDir,
            programs: path.join(tmpDir, "programs"),
            artifacts: path.join(tmpDir, "artifacts"),
            typechain: typechainDir,
            cache: path.join(tmpDir, "cache"),
            deployments: path.join(tmpDir, "deployments"),
          },
        }),
        plugins: [pluginLeo],
      });

      await expect(lre.tasks.run("compile", { program: "foo__bar" })).rejects.toThrow(
        /overwrite an unrelated generated module/,
      );
      expect(fs.existsSync(path.join(typechainDir, "BaseContract.ts"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects targeted compile when an existing generated module cannot be identified", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-leo-typechain-"));
    const core = await import("@lionden/core");
    const compiler = await import("@lionden/leo-compiler");

    vi.spyOn(core, "preflightLeo").mockResolvedValue(undefined);
    vi.spyOn(compiler, "compilePipeline").mockResolvedValue({
      results: [programResult("foo__bar.aleo")],
    } as any);
    vi.spyOn(compiler, "generateBaseContract").mockReturnValue("// base contract\n");

    try {
      const typechainDir = path.join(tmpDir, "typechain");
      fs.mkdirSync(typechainDir, { recursive: true });
      fs.writeFileSync(path.join(typechainDir, "FooBar.ts"), "// legacy generated module\n");

      const lre = createLre({
        config: createMockConfig({
          paths: {
            root: tmpDir,
            programs: path.join(tmpDir, "programs"),
            artifacts: path.join(tmpDir, "artifacts"),
            typechain: typechainDir,
            cache: path.join(tmpDir, "cache"),
            deployments: path.join(tmpDir, "deployments"),
          },
        }),
        plugins: [pluginLeo],
      });

      await expect(lre.tasks.run("compile", { program: "foo__bar" })).rejects.toThrow(
        /source program could not be determined/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
