/**
 * Tier 2 contract test — crosses: @lionden/plugin-test + @lionden/core
 *
 * Tests the test task registration, config validation, and arg flow.
 * Mocks vitest/node to capture the config that runTests passes to startVitest.
 */

import { join } from "node:path";
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

  it("--prove sets LIONDEN_PROVE env var", async () => {
    const lre = createTestLre();

    await lre.tasks.run("test", { noCompile: true, prove: true });

    // The test runner should have set LIONDEN_PROVE before calling startVitest
    const { startVitest } = await import("vitest/node");
    expect(startVitest).toHaveBeenCalledOnce();
    // Since we can't easily check env at call time, verify the env is set after the call
    // (the mock resolves synchronously, so the env var should still be set)
    expect(process.env["LIONDEN_PROVE"]).toBe("true");
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
