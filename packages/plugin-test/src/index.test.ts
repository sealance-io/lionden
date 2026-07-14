import { createLre, task } from "@lionden/core";
import { createMockConfig } from "@lionden/test-internals";
import { afterEach, describe, expect, it, vi } from "vitest";
import pluginTest from "./index.js";

const originalNoColor = process.env["NO_COLOR"];
const originalManagedTest = process.env["LIONDEN_MANAGED_TEST"];

vi.mock("vitest/node", () => ({
  startVitest: vi.fn().mockResolvedValue({
    close: vi.fn().mockResolvedValue(undefined),
    state: { getFiles: () => [] },
  }),
}));

describe("plugin-test", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNoColor === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = originalNoColor;
    }
    if (originalManagedTest === undefined) {
      delete process.env["LIONDEN_MANAGED_TEST"];
    } else {
      process.env["LIONDEN_MANAGED_TEST"] = originalManagedTest;
    }
  });

  describe("plugin definition", () => {
    it("has correct id", () => {
      expect(pluginTest.id).toBe("@lionden/plugin-test");
    });

    it("has a human-readable name", () => {
      expect(pluginTest.name).toBe("Test Plugin");
    });

    it("registers the test task", () => {
      expect(pluginTest.tasks).toHaveLength(1);
      expect(pluginTest.tasks![0]!.id).toBe("test");
    });

    it("has config hook handlers", () => {
      expect(pluginTest.hookHandlers).toBeDefined();
      expect(pluginTest.hookHandlers!.config).toBeDefined();
    });

    it("has testing hook handlers", () => {
      expect(pluginTest.hookHandlers!.testing).toBeDefined();
    });
  });

  describe("test task definition", () => {
    const testTask = pluginTest.tasks![0]!;

    it("has correct description", () => {
      expect(testTask.description).toBe("Run tests with managed devnode lifecycle");
    });

    it("has grep option", () => {
      const grep = testTask.options?.find((o) => o.name === "grep");
      expect(grep).toBeDefined();
      expect(grep!.type).toBe("string");
    });

    it("has timeout option", () => {
      const timeout = testTask.options?.find((o) => o.name === "timeout");
      expect(timeout).toBeDefined();
      expect(timeout!.type).toBe("number");
    });

    it("has noCompile flag", () => {
      const noCompile = testTask.flags?.find((f) => f.name === "noCompile");
      expect(noCompile).toBeDefined();
    });

    it("does not define a local prove flag (--prove is a framework built-in global)", () => {
      const prove = testTask.flags?.find((f) => f.name === "prove");
      expect(prove).toBeUndefined();
    });

    it("declares test files as a variadic positional argument", () => {
      const files = testTask.positionalArguments?.find((arg) => arg.name === "files");
      expect(files).toBeDefined();
      expect(files?.variadic).toBe(true);
    });
  });

  describe("config validation", () => {
    const configHooks = pluginTest.hookHandlers!.config as {
      validateResolvedConfig: (config: unknown) => { path: string; message: string }[];
    };

    it("validates positive timeout", () => {
      const errors = configHooks.validateResolvedConfig({
        testing: { framework: "vitest", timeout: 0, autoStartDevnode: true },
      });
      expect(errors.some((e) => e.path === "testing.timeout")).toBe(true);
    });

    it("validates supported framework", () => {
      const errors = configHooks.validateResolvedConfig({
        testing: { framework: "jest", timeout: 120_000, autoStartDevnode: true },
      });
      expect(errors.some((e) => e.path === "testing.framework")).toBe(true);
    });

    it("passes valid config", () => {
      const errors = configHooks.validateResolvedConfig({
        testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
      });
      expect(errors).toHaveLength(0);
    });
  });

  it("suppresses dividers for nested compile during managed test runs", async () => {
    process.env["NO_COLOR"] = "1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const compileTask = task("compile", "compile")
      .setAction(async () => undefined)
      .build();
    const lre = createLre({
      config: createMockConfig(),
      plugins: [
        pluginTest,
        {
          id: "test-compile-plugin",
          name: "Test Compile Plugin",
          tasks: [compileTask],
        },
      ],
    });

    await lre.tasks.run("test");

    expect(logSpy.mock.calls.map(([message]) => String(message))).toEqual([
      'Running task "test"',
      'Running task "compile"',
      "\nTests: 0 passed, 0 failed, 0 skipped (0 files)",
    ]);
    expect(process.env["LIONDEN_MANAGED_TEST"]).toBeUndefined();
  });
});
