import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silenceProvableSdkConsoleNoise } from "./sdk-console-filter.js";

// Mock vitest/node so runTests can be invoked without starting real Vitest.
vi.mock("vitest/node", () => ({
  startVitest: vi.fn().mockResolvedValue({
    close: vi.fn().mockResolvedValue(undefined),
    state: { getFiles: () => [] },
  }),
}));

import { runTests } from "./test-runner.js";

describe("test-runner", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env after each test
    for (const key of [
      "FORCE_COLOR",
      "NO_COLOR",
      "LIONDEN_PROJECT_ROOT",
      "LIONDEN_CONFIG_PATH",
      "LIONDEN_PROVE",
      "LIONDEN_NETWORK",
    ]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe("env var injection", () => {
    it("runTests function is exported", () => {
      expect(typeof runTests).toBe("function");
    });

    it("sets LIONDEN_PROJECT_ROOT to the project root", async () => {
      await runTests({ root: "/tmp/proj" });
      expect(process.env["LIONDEN_PROJECT_ROOT"]).toBe("/tmp/proj");
    });

    it("sets LIONDEN_CONFIG_PATH when an exact config file is provided", async () => {
      await runTests({ root: "/tmp/proj", configPath: "/tmp/proj/lionden.http.config.ts" });
      expect(process.env["LIONDEN_CONFIG_PATH"]).toBe("/tmp/proj/lionden.http.config.ts");
    });

    it("clears LIONDEN_CONFIG_PATH when no exact config file is provided", async () => {
      process.env["LIONDEN_CONFIG_PATH"] = "/tmp/stale.config.ts";
      await runTests({ root: "/tmp/proj" });
      expect(process.env["LIONDEN_CONFIG_PATH"]).toBeUndefined();
    });

    it("sets LIONDEN_PROVE when prove is true", async () => {
      delete process.env["LIONDEN_PROVE"];
      await runTests({ root: "/tmp/test", prove: true });
      expect(process.env["LIONDEN_PROVE"]).toBe("true");
    });

    it("clears LIONDEN_PROVE when prove is explicitly false, even with an ambient value", async () => {
      // `false ?? env === false`: an explicit false still clears (Finding 1).
      process.env["LIONDEN_PROVE"] = "true";
      await runTests({ root: "/tmp/test", prove: false });
      expect(process.env["LIONDEN_PROVE"]).toBeUndefined();
    });

    it("honors and canonicalizes a truthy ambient LIONDEN_PROVE when prove is omitted", async () => {
      // undefined → honor (and canonicalize) the ambient env (Finding 1).
      process.env["LIONDEN_PROVE"] = "1";
      await runTests({ root: "/tmp/test" });
      expect(process.env["LIONDEN_PROVE"]).toBe("true");
    });

    it("leaves LIONDEN_PROVE unset when prove is omitted and no ambient env is present", async () => {
      delete process.env["LIONDEN_PROVE"];
      await runTests({ root: "/tmp/test" });
      expect(process.env["LIONDEN_PROVE"]).toBeUndefined();
    });

    it("sets LIONDEN_NETWORK when network is provided", async () => {
      delete process.env["LIONDEN_NETWORK"];
      await runTests({ root: "/tmp/test", network: "altDevnode" });
      expect(process.env["LIONDEN_NETWORK"]).toBe("altDevnode");
    });

    it("clears LIONDEN_NETWORK when network is omitted, even with an ambient value", async () => {
      process.env["LIONDEN_NETWORK"] = "stale";
      await runTests({ root: "/tmp/test" });
      expect(process.env["LIONDEN_NETWORK"]).toBeUndefined();
    });
  });

  describe("TestRunnerResult shape", () => {
    it("describes the expected result contract", () => {
      const mockResult = {
        success: true,
        testFiles: 3,
        passed: 10,
        failed: 0,
        skipped: 1,
      };

      expect(mockResult.success).toBe(true);
      expect(mockResult.testFiles).toBe(3);
      expect(mockResult.passed).toBe(10);
      expect(mockResult.failed).toBe(0);
      expect(mockResult.skipped).toBe(1);
    });
  });

  describe("vitest options", () => {
    it("installs the Provable SDK console-noise filter", async () => {
      await runTests({ root: "/tmp/proj" });

      const { startVitest } = await import("vitest/node");
      const callArgs = (startVitest as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const vitestConfig = callArgs[2] as Record<string, unknown>;

      expect(vitestConfig.onConsoleLog).toBe(silenceProvableSdkConsoleNoise);
    });

    it("forwards color support to Vitest workers when the parent terminal supports color", async () => {
      const originalIsTTY = process.stdout.isTTY;
      delete process.env["NO_COLOR"];
      delete process.env["FORCE_COLOR"];
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      const { startVitest } = await import("vitest/node");
      vi.mocked(startVitest).mockImplementationOnce(async () => {
        expect(process.env["FORCE_COLOR"]).toBe("1");
        return {
          close: vi.fn().mockResolvedValue(undefined),
          state: { getFiles: () => [] },
        } as any;
      });

      try {
        await runTests({ root: "/tmp/proj" });
      } finally {
        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          value: originalIsTTY,
        });
      }

      expect(process.env["FORCE_COLOR"]).toBeUndefined();
    });

    it("does not force color for Vitest workers when NO_COLOR is set", async () => {
      const originalIsTTY = process.stdout.isTTY;
      process.env["NO_COLOR"] = "1";
      delete process.env["FORCE_COLOR"];
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: true,
      });
      const { startVitest } = await import("vitest/node");
      vi.mocked(startVitest).mockImplementationOnce(async () => {
        expect(process.env["FORCE_COLOR"]).toBeUndefined();
        return {
          close: vi.fn().mockResolvedValue(undefined),
          state: { getFiles: () => [] },
        } as any;
      });

      try {
        await runTests({ root: "/tmp/proj" });
      } finally {
        Object.defineProperty(process.stdout, "isTTY", {
          configurable: true,
          value: originalIsTTY,
        });
      }
    });
  });
});
