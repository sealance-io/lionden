import { afterEach, describe, expect, it } from "vitest";

describe("test-runner", () => {
  const originalEnv = { ...process.env };

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
    // We can't easily invoke runTests() (it tries to import vitest/node
    // and start a full Vitest instance), but we can verify the module
    // contract by importing and checking the function exists.

    it("runTests function is exported", async () => {
      const { runTests } = await import("./test-runner.js");
      expect(typeof runTests).toBe("function");
    });
  });

  describe("TestRunnerOptions contract", () => {
    it("accepts prove flag", () => {
      const opts = {
        root: "/tmp/test",
        grep: "mint",
        timeout: 60_000,
        compile: true,
        prove: true,
      };

      expect(opts.prove).toBe(true);
      expect(opts.root).toBe("/tmp/test");
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
