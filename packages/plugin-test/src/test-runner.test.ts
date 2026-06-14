import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    for (const key of ["LIONDEN_PROJECT_ROOT", "LIONDEN_PROVE"]) {
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
});
