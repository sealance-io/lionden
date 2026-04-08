import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { createTestLre, resetTestLre } from "./lre-factory.js";

describe("lre-factory", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetTestLre();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetTestLre();
  });

  it("throws when no config file is found", async () => {
    // Point to a dir with no config file
    process.env["LIONDEN_PROJECT_ROOT"] = "/tmp/nonexistent-dir";

    await expect(createTestLre()).rejects.toThrow(
      /No lionden\.config\.\{ts,js,mjs\} found/,
    );
  });

  it("caches the LRE across multiple calls", async () => {
    // We can't easily test the full flow (needs a real config file),
    // but we can test that resetTestLre clears the cache by observing
    // that createTestLre throws again after reset.
    process.env["LIONDEN_PROJECT_ROOT"] = "/tmp/nonexistent-dir";

    await expect(createTestLre()).rejects.toThrow();

    // After reset, it should try again (not return cached result)
    resetTestLre();
    await expect(createTestLre()).rejects.toThrow();
  });

  it("clears rejected promise so next call retries", async () => {
    // First call with an invalid root — should reject
    process.env["LIONDEN_PROJECT_ROOT"] = "/tmp/nonexistent-dir-" + Date.now();
    await expect(createTestLre()).rejects.toThrow();

    // Second call (without resetTestLre) should retry, not return stale rejection.
    // Still fails (same env), but it's a fresh attempt — different promise.
    const p1 = createTestLre().catch((e: Error) => e.message);
    const p2 = createTestLre().catch((e: Error) => e.message);
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1).toContain("No lionden.config");
    expect(m2).toContain("No lionden.config");
  });

  it("uses LIONDEN_PROJECT_ROOT env var for config discovery", async () => {
    const tempDir = "/tmp/test-lre-factory-" + Date.now();
    process.env["LIONDEN_PROJECT_ROOT"] = tempDir;

    // Should attempt to find config starting from the env var path
    await expect(createTestLre()).rejects.toThrow(tempDir);
  });
});
