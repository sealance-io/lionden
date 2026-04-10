/**
 * Tier 2 contract test — crosses: @lionden/plugin-test + @lionden/core
 *
 * Tests the test task registration, config validation, and arg flow.
 * Mocks vitest/node to capture the config that runTests passes to startVitest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockConfig } from "@lionden/test-internals";
import { createContractLre, type ContractLreResult } from "@lionden/test-internals";
import pluginTest from "./index.js";

// Mock vitest/node so we don't start real vitest
vi.mock("vitest/node", () => ({
  startVitest: vi.fn().mockResolvedValue({
    close: vi.fn().mockResolvedValue(undefined),
    state: {
      getFiles: () => [
        {
          tasks: [
            { result: { state: "pass" } },
            { result: { state: "pass" } },
          ],
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
