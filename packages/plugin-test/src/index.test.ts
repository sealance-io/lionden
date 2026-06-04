import { describe, expect, it } from "vitest";
import pluginTest from "./index.js";

describe("plugin-test", () => {
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

    it("has prove flag", () => {
      const prove = testTask.flags?.find((f) => f.name === "prove");
      expect(prove).toBeDefined();
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
});
