import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import pluginLeo from "./index.js";
import { createLre, type ConfigHookHandlers } from "@lionden/core";
import { createMockConfig } from "@lionden/test-internals";

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

  it("has config and compilation hook handlers", () => {
    expect(pluginLeo.hookHandlers).toBeDefined();
    expect(pluginLeo.hookHandlers!.config).toBeDefined();
    expect(pluginLeo.hookHandlers!.compilation).toBeDefined();
  });

  it("compile task has force, noTypechain, and program options", () => {
    const compileTask = pluginLeo.tasks?.find((t) => t.id === "compile");
    expect(compileTask).toBeDefined();

    const optionNames = compileTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("force");
    expect(optionNames).toContain("program");

    const flagNames = compileTask!.flags?.map((f) => f.name) ?? [];
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
    for (const leoVersion of ["4.0.0", "4.0.1", "4.0.2", "3.5.0", "3.5.1"]) {
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
      "4.1.0",
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
    const rejected = [
      "^5.0.0",
      " 5.0.0",
      "5.0.0 ",
      "5.0.0-rc1",
      "5.0.0+build",
      "bad",
    ];

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
    expect(errors.map((e) => e.path)).toEqual([
      "skipLeoVersionCheck",
      "leoVersion",
    ]);
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
