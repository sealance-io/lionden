/**
 * Tier 2 contract test — crosses: @lionden/plugin-test + @lionden/core
 *
 * Tests the test task registration, config validation, and arg flow.
 * Mocks vitest/node to capture the config that runTests passes to startVitest.
 */

import { join } from "node:path";
import { type LionDenPlugin, task } from "@lionden/core";
import {
  type ContractLreResult,
  createContractLre,
  createMockConfig,
} from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pluginTest from "./index.js";
import { runTests } from "./test-runner.js";

// Mock vitest/node so we don't start real vitest
vi.mock("vitest/node", () => ({
  startVitest: vi.fn().mockResolvedValue({
    close: vi.fn().mockResolvedValue(undefined),
    state: {
      getFiles: () => [
        {
          tasks: [{ result: { state: "pass" } }, { result: { state: "pass" } }],
        },
      ],
    },
  }),
}));

describe("test task contract", () => {
  const originalEnv = { ...process.env };
  let fixture: ContractLreResult | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fixture?.cleanup();
    fixture = undefined;
  });

  function createTestLre(configOverrides?: Record<string, unknown>) {
    fixture = createContractLre({
      plugins: [pluginTest],
      withMockCompile: true,
      configOverrides: configOverrides as any,
    });
    return fixture.lre;
  }

  it("test task is registered in LRE", () => {
    const lre = createTestLre();
    expect(lre.tasks.has("test")).toBe(true);
  });

  it("--grep flows through to vitest testNamePattern", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true, grep: "mint" });

    const { startVitest } = await import("vitest/node");
    expect(startVitest).toHaveBeenCalledOnce();

    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;
    expect(vitestConfig.testNamePattern).toBe("mint");
  });

  it("forces one-shot vitest mode", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;

    expect(callArgs[0]).toBe("test");
    expect(vitestConfig.run).toBe(true);
    expect(vitestConfig.watch).toBe(false);
  });

  it("runs vitest with project-local discovery only", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;

    expect(vitestConfig.root).toBe(lre.config.paths.root);
    expect(vitestConfig.config).toBe(false);
    expect(vitestConfig.include).toEqual(["test/**/*.test.ts"]);
  });

  it("uses positional test files as vitest include patterns and preserves --grep", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", {
      noCompile: true,
      grep: "orders",
      _positional: ["test/orders.test.ts", "test/tally.test.ts"],
    });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;

    expect(vitestConfig.include).toEqual(["test/orders.test.ts", "test/tally.test.ts"]);
    expect(vitestConfig.testNamePattern).toBe("orders");
  });

  it("--timeout overrides default from config", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true, timeout: 30_000 });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;
    expect(vitestConfig.testTimeout).toBe(30_000);
  });

  it("uses config timeout when --timeout is not specified", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;
    expect(vitestConfig.testTimeout).toBe(120_000);
  });

  it("--noCompile skips the compile task", async () => {
    const lre = createTestLre();
    const compileSpy = vi.spyOn(lre.tasks, "run");

    await lre.tasks.run("test", { noCompile: true });

    // tasks.run should only be called for "test", not "compile"
    const taskIds = compileSpy.mock.calls.map((c) => c[0]);
    expect(taskIds).not.toContain("compile");
  });

  it("runs compile when --noCompile is not set", async () => {
    const lre = createTestLre();
    const compileSpy = vi.spyOn(lre.tasks, "run");

    await lre.tasks.run("test", {});

    const taskIds = compileSpy.mock.calls.map((c) => c[0]);
    expect(taskIds).toContain("compile");
  });

  it("runs suiteTeardown when a later serial suiteSetup hook fails", async () => {
    const { startVitest } = await import("vitest/node");
    const events: string[] = [];
    const setupError = new Error("suite setup failed");
    const firstTestingPlugin: LionDenPlugin = {
      id: "first-testing-plugin",
      name: "First Testing Plugin",
      hookHandlers: {
        testing: {
          suiteSetup: () => {
            events.push("first setup");
          },
          suiteTeardown: () => {
            events.push("first teardown");
          },
        },
      },
    };
    const failingTestingPlugin: LionDenPlugin = {
      id: "failing-testing-plugin",
      name: "Failing Testing Plugin",
      hookHandlers: {
        testing: {
          suiteSetup: () => {
            events.push("second setup");
            throw setupError;
          },
        },
      },
    };
    fixture = createContractLre({
      plugins: [pluginTest, firstTestingPlugin, failingTestingPlugin],
      withMockCompile: true,
    });

    await expect(fixture.lre.tasks.run("test", { noCompile: true })).rejects.toBe(setupError);

    expect(events).toEqual(["first setup", "second setup", "first teardown"]);
    expect(startVitest).not.toHaveBeenCalled();
  });

  it("preserves a test-run failure before an additional suiteTeardown failure", async () => {
    const { startVitest } = await import("vitest/node");
    (startVitest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      close: vi.fn().mockResolvedValue(undefined),
      state: {
        getFiles: () => [
          {
            tasks: [{ result: { state: "fail" } }],
          },
        ],
      },
    });
    const teardownError = new Error("suite teardown failed");
    const teardownPlugin: LionDenPlugin = {
      id: "teardown-fails-after-tests",
      name: "Teardown Fails After Tests",
      hookHandlers: {
        testing: {
          suiteTeardown: () => {
            throw teardownError;
          },
        },
      },
    };
    fixture = createContractLre({
      plugins: [pluginTest, teardownPlugin],
      withMockCompile: true,
    });

    let thrown: unknown;
    try {
      await fixture.lre.tasks.run("test", { noCompile: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toBe(
      "Test task failed during run and suite teardown. Run: 1 test(s) failed.; teardown: suite teardown failed",
    );
    const errors = (thrown as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe("1 test(s) failed.");
    expect(errors[1]).toBe(teardownError);
  });

  it("preserves an undefined setup failure before an additional suiteTeardown failure", async () => {
    const { startVitest } = await import("vitest/node");
    const teardownError = new Error("suite teardown failed");
    const setupThrowsUndefinedPlugin: LionDenPlugin = {
      id: "setup-throws-undefined",
      name: "Setup Throws Undefined",
      hookHandlers: {
        testing: {
          suiteSetup: () => {
            throw undefined;
          },
          suiteTeardown: () => {
            throw teardownError;
          },
        },
      },
    };
    fixture = createContractLre({
      plugins: [pluginTest, setupThrowsUndefinedPlugin],
      withMockCompile: true,
    });

    let thrown: unknown;
    try {
      await fixture.lre.tasks.run("test", { noCompile: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toBe(
      "Test task failed during run and suite teardown. Run: undefined; teardown: suite teardown failed",
    );
    expect((thrown as AggregateError).errors).toEqual([undefined, teardownError]);
    expect(startVitest).not.toHaveBeenCalled();
  });

  it("propagates compile failure unchanged without suite hooks or Vitest", async () => {
    const { startVitest } = await import("vitest/node");
    const compileError = new Error("compile failed before tests");
    const suiteSetup = vi.fn();
    const suiteTeardown = vi.fn();
    const failingCompilePlugin: LionDenPlugin = {
      id: "compile-fails",
      name: "Compile Fails",
      tasks: [
        task("compile", "Failing compile")
          .setAction(async () => {
            throw compileError;
          })
          .build(),
      ],
    };
    const testingPlugin: LionDenPlugin = {
      id: "testing-hooks",
      name: "Testing Hooks",
      hookHandlers: {
        testing: {
          suiteSetup,
          suiteTeardown,
        },
      },
    };
    fixture = createContractLre({
      plugins: [pluginTest, failingCompilePlugin, testingPlugin],
    });

    await expect(fixture.lre.tasks.run("test")).rejects.toBe(compileError);

    expect(suiteSetup).not.toHaveBeenCalled();
    expect(suiteTeardown).not.toHaveBeenCalled();
    expect(startVitest).not.toHaveBeenCalled();
  });

  it("throws an unwrapped suiteTeardown error when setup and Vitest succeed", async () => {
    const teardownError = new Error("suite teardown failed");
    const teardownPlugin: LionDenPlugin = {
      id: "teardown-only-fails",
      name: "Teardown Only Fails",
      hookHandlers: {
        testing: {
          suiteSetup: () => undefined,
          suiteTeardown: () => {
            throw teardownError;
          },
        },
      },
    };
    fixture = createContractLre({
      plugins: [pluginTest, teardownPlugin],
      withMockCompile: true,
    });

    await expect(fixture.lre.tasks.run("test", { noCompile: true })).rejects.toBe(teardownError);
  });

  it("defaults to serial file execution (fileParallelism: false)", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;
    expect(vitestConfig.fileParallelism).toBe(false);
  });

  it("--parallel enables fileParallelism", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true, parallel: true });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;
    expect(vitestConfig.fileParallelism).toBe(true);
  });

  it("leaves coverage disabled by default", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;

    expect(vitestConfig.coverage).toBeUndefined();
    expect(vitestConfig.reporters).toBeUndefined();
  });

  it("--coverage configures package-source coverage", async () => {
    const lre = createTestLre();
    const sourceRoot = process.cwd();

    await lre.tasks.run("test", { noCompile: true, coverage: true });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;

    expect(vitestConfig.coverage).toEqual({
      provider: "v8",
      enabled: true,
      allowExternal: true,
      include: [join(sourceRoot, "packages/*/src/**/*.ts").replaceAll("\\", "/")],
      exclude: [
        join(sourceRoot, "packages/*/src/**/*.test.ts").replaceAll("\\", "/"),
        join(sourceRoot, "packages/*/src/**/*.contract.test.ts").replaceAll("\\", "/"),
        join(sourceRoot, "packages/*/src/**/*.d.ts").replaceAll("\\", "/"),
        join(sourceRoot, "packages/test-internals/src/**/*.ts").replaceAll("\\", "/"),
        join(sourceRoot, "packages/*/src/**/__goldens__/**").replaceAll("\\", "/"),
      ],
      reportsDirectory: join(sourceRoot, "coverage"),
      reporter: ["text-summary", "html", "lcov"],
    });
    expect(vitestConfig.alias).toMatchObject({
      "@lionden/testing": join(sourceRoot, "packages/testing/src/index.ts"),
    });
  });

  it("passes blob reporter output for smoke-style coverage options", async () => {
    await runTests({
      root: "/tmp/lionden/example",
      coverage: {
        sourceRoot: "/tmp/lionden",
        reportsDirectory: "/tmp/lionden/.vitest/smoke-coverage/core/runs/hello-world",
        blobOutputFile: "/tmp/lionden/.vitest/smoke-coverage/core/blobs/hello-world.json",
      },
    });

    const { startVitest } = await import("vitest/node");
    const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const vitestConfig = callArgs[2] as Record<string, unknown>;

    expect(vitestConfig.reporters).toEqual([
      [
        "blob",
        {
          outputFile: "/tmp/lionden/.vitest/smoke-coverage/core/blobs/hello-world.json",
        },
      ],
    ]);
    expect(vitestConfig.coverage).toMatchObject({
      provider: "v8",
      enabled: true,
      allowExternal: true,
      reportsDirectory: "/tmp/lionden/.vitest/smoke-coverage/core/runs/hello-world",
    });
  });

  it("counts nested test tasks and failed suites", async () => {
    const { startVitest } = await import("vitest/node");
    (startVitest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      close: vi.fn().mockResolvedValue(undefined),
      state: {
        getFiles: () => [
          {
            tasks: [
              {
                result: { state: "pass" },
                tasks: [
                  { result: { state: "pass" } },
                  { result: { state: "fail" } },
                  { result: { state: "skip" } },
                ],
              },
              {
                result: { state: "fail" },
                tasks: [{ result: { state: "skip" } }],
              },
            ],
          },
        ],
      },
    });

    const result = await runTests({ root: "/tmp/lionden/example" });

    expect(result).toEqual({
      success: false,
      testFiles: 1,
      passed: 1,
      failed: 2,
      skipped: 2,
    });
  });

  describe("prove resolution", () => {
    it("global prove=true canonicalizes LIONDEN_PROVE and runs proving", async () => {
      const lre = createTestLre();
      lre.globalOptions["prove"] = true;

      await lre.tasks.run("test", { noCompile: true });

      const { startVitest } = await import("vitest/node");
      expect(startVitest).toHaveBeenCalledOnce();
      expect(process.env["LIONDEN_PROVE"]).toBe("true");
    });

    it("global prove=false clears an ambient LIONDEN_PROVE", async () => {
      process.env["LIONDEN_PROVE"] = "true";
      const lre = createTestLre();
      lre.globalOptions["prove"] = false;

      await lre.tasks.run("test", { noCompile: true });

      expect(process.env["LIONDEN_PROVE"]).toBeUndefined();
    });

    it("honors a truthy ambient LIONDEN_PROVE, canonicalizes it, and prints a notice", async () => {
      process.env["LIONDEN_PROVE"] = "1";
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const lre = createTestLre();

      await lre.tasks.run("test", { noCompile: true });

      expect(process.env["LIONDEN_PROVE"]).toBe("true");
      expect(logSpy.mock.calls.flat()).toContain("Proving enabled via LIONDEN_PROVE");
      logSpy.mockRestore();
    });

    it("deletes LIONDEN_PROVE when neither a global nor an env requests proving", async () => {
      const lre = createTestLre();

      await lre.tasks.run("test", { noCompile: true });

      expect(process.env["LIONDEN_PROVE"]).toBeUndefined();
    });

    it("resolves and canonicalizes LIONDEN_PROVE BEFORE suiteSetup runs", async () => {
      // A testing.suiteSetup hook must observe the already-resolved env value,
      // not whatever ambient value preceded resolution.
      process.env["LIONDEN_PROVE"] = "yes"; // truthy spelling, not yet canonical
      let envAtSuiteSetup: string | undefined = "unset-sentinel";
      const recordingPlugin: LionDenPlugin = {
        id: "record-prove",
        name: "Record Prove",
        hookHandlers: {
          testing: {
            suiteSetup: () => {
              envAtSuiteSetup = process.env["LIONDEN_PROVE"];
            },
          },
        },
      };

      fixture = createContractLre({
        plugins: [pluginTest, recordingPlugin],
        withMockCompile: true,
      });

      await fixture.lre.tasks.run("test", { noCompile: true });

      // Canonicalized to "true" before the hook saw it.
      expect(envAtSuiteSetup).toBe("true");
    });
  });

  describe("network bridge", () => {
    it("forwards an explicit globalOptions.network to runTests via LIONDEN_NETWORK", async () => {
      const lre = createTestLre();
      lre.globalOptions["network"] = "altnet";

      await lre.tasks.run("test", { noCompile: true });

      expect(process.env["LIONDEN_NETWORK"]).toBe("altnet");
    });

    it("prints a notice naming the explicit network", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const lre = createTestLre();
      lre.globalOptions["network"] = "altnet";

      await lre.tasks.run("test", { noCompile: true });

      expect(logSpy.mock.calls.flat()).toContain('Running tests against network "altnet"');
      logSpy.mockRestore();
    });

    it("forwards the exact CLI config path to workers", async () => {
      const lre = createTestLre();
      lre.globalOptions["configPath"] = "/tmp/lionden/http.config.ts";

      await lre.tasks.run("test", { noCompile: true });

      expect(process.env["LIONDEN_CONFIG_PATH"]).toBe("/tmp/lionden/http.config.ts");
    });

    it("leaves LIONDEN_NETWORK unset when no explicit network is selected", async () => {
      const lre = createTestLre();

      await lre.tasks.run("test", { noCompile: true });

      expect(process.env["LIONDEN_NETWORK"]).toBeUndefined();
    });
  });

  it("config validation rejects timeout <= 0 through LRE hook dispatch", async () => {
    const config = createMockConfig();
    const configHooks = pluginTest.hookHandlers!.config as {
      validateResolvedConfig: (config: unknown) => { path: string; message: string }[];
    };

    const errors = configHooks.validateResolvedConfig({
      ...config,
      testing: { ...config.testing, timeout: -1 },
    });
    expect(errors.some((e) => e.path === "testing.timeout")).toBe(true);
  });

  it("config validation rejects unsupported framework", async () => {
    const config = createMockConfig();
    const configHooks = pluginTest.hookHandlers!.config as {
      validateResolvedConfig: (config: unknown) => { path: string; message: string }[];
    };

    const errors = configHooks.validateResolvedConfig({
      ...config,
      testing: { ...config.testing, framework: "jest" },
    });
    expect(errors.some((e) => e.path === "testing.framework")).toBe(true);
  });
});
