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

  /**
   * The link that was missing: the CLI parks `--deploy-backend` in
   * `lre.globalOptions`, but Vitest workers rebuild their LRE from disk with no
   * globalOptions at all. Unless the task action copies it into the environment,
   * `TestContext.deploy()` never sees the flag and silently uses the SDK.
   */
  describe("bridges --deploy-backend to workers", () => {
    const originalBackend = process.env["LIONDEN_DEPLOY_BACKEND"];

    afterEach(() => {
      if (originalBackend === undefined) delete process.env["LIONDEN_DEPLOY_BACKEND"];
      else process.env["LIONDEN_DEPLOY_BACKEND"] = originalBackend;
    });

    /** Run the real `test` task action with `noCompile`, so only bridging runs. */
    async function runTestTask(globalOptions: Record<string, unknown>, args = {}) {
      const lre = createLre({
        config: createMockConfig(),
        plugins: [pluginTest],
        globalOptions,
      });
      const testTask = pluginTest.tasks!.find((t) => t.id === "test")!;
      await testTask.action({ noCompile: true, ...args }, lre);
    }

    it("copies an explicit --deploy-backend into LIONDEN_DEPLOY_BACKEND", async () => {
      delete process.env["LIONDEN_DEPLOY_BACKEND"];
      await runTestTask({ deployBackend: "leo" });
      expect(process.env["LIONDEN_DEPLOY_BACKEND"]).toBe("leo");
    });

    it("lets the flag override an ambient LIONDEN_DEPLOY_BACKEND", async () => {
      process.env["LIONDEN_DEPLOY_BACKEND"] = "sdk";
      await runTestTask({ deployBackend: "leo" });
      expect(process.env["LIONDEN_DEPLOY_BACKEND"]).toBe("leo");
    });

    it("preserves an ambient LIONDEN_DEPLOY_BACKEND when no flag is given", async () => {
      process.env["LIONDEN_DEPLOY_BACKEND"] = "leo";
      await runTestTask({});
      expect(process.env["LIONDEN_DEPLOY_BACKEND"]).toBe("leo");
    });

    it("leaves the env untouched on a plain run", async () => {
      delete process.env["LIONDEN_DEPLOY_BACKEND"];
      await runTestTask({});
      expect(process.env["LIONDEN_DEPLOY_BACKEND"]).toBeUndefined();
    });

    it("accepts a programmatic deployBackend argument", async () => {
      delete process.env["LIONDEN_DEPLOY_BACKEND"];
      await runTestTask({}, { deployBackend: "leo" });
      expect(process.env["LIONDEN_DEPLOY_BACKEND"]).toBe("leo");
    });

    /** `tasks.run("test", ...)` never passes through the CLI's own validation. */
    it("rejects an unrecognized backend before starting Vitest", async () => {
      await expect(runTestTask({}, { deployBackend: "provable" })).rejects.toThrow(
        /Invalid deploy backend "provable"/,
      );
    });

    /**
     * Only `undefined` means "unset". A `??` between the two layers would treat
     * a malformed `null` as absent and quietly run on the global's backend —
     * the caller asked for something broken and would get a silent substitution
     * instead of an error. The valid global here is what makes the fall-through
     * observable: with `??` this resolves to "leo" and passes.
     */
    it("rejects a null argument instead of falling through to the global", async () => {
      delete process.env["LIONDEN_DEPLOY_BACKEND"];
      await expect(runTestTask({ deployBackend: "leo" }, { deployBackend: null })).rejects.toThrow(
        /Invalid deploy backend null/,
      );
      expect(process.env["LIONDEN_DEPLOY_BACKEND"]).toBeUndefined();
    });

    it("rejects a null global rather than treating it as unset", async () => {
      await expect(runTestTask({ deployBackend: null })).rejects.toThrow(
        /Invalid deploy backend null/,
      );
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
