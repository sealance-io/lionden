import { describe, it, expect, vi } from "vitest";
import { TaskRunnerImpl, TaskNotFoundError } from "./task-runner.js";
import type { TaskDefinition, LionDenRuntimeEnvironment } from "./types.js";

function makeLre(): LionDenRuntimeEnvironment {
  return {
    config: {} as LionDenRuntimeEnvironment["config"],
    network: null,
    tasks: {} as LionDenRuntimeEnvironment["tasks"],
    hooks: {} as LionDenRuntimeEnvironment["hooks"],
    artifacts: {} as LionDenRuntimeEnvironment["artifacts"],
    plugins: [],
    globalOptions: {},
  };
}

describe("TaskRunnerImpl", () => {
  describe("arg normalization", () => {
    it("maps kebab-case flag to camelCase", async () => {
      const action = vi.fn();
      const runner = new TaskRunnerImpl();
      const task: TaskDefinition = {
        id: "test",
        description: "test",
        action,
        flags: [{ name: "noCompile", description: "skip compile" }],
      };
      runner.registerTasks([task]);
      runner.setLre(makeLre());

      // Simulate CLI parser output: --no-compile → { "no-compile": true }
      await runner.run("test", { "no-compile": true });

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ noCompile: true }),
        expect.anything(),
      );
    });

    it("coerces string timeout to number", async () => {
      const action = vi.fn();
      const runner = new TaskRunnerImpl();
      const task: TaskDefinition = {
        id: "test",
        description: "test",
        action,
        options: [{ name: "timeout", type: "number", description: "timeout" }],
      };
      runner.registerTasks([task]);
      runner.setLre(makeLre());

      // Simulate CLI parser output: --timeout 5000 → { timeout: "5000" }
      await runner.run("test", { timeout: "5000" });

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 5000 }),
        expect.anything(),
      );
    });

    it("preserves already-typed values from programmatic callers", async () => {
      const action = vi.fn();
      const runner = new TaskRunnerImpl();
      const task: TaskDefinition = {
        id: "compile",
        description: "compile",
        action,
        options: [{ name: "timeout", type: "number", description: "timeout" }],
        flags: [{ name: "noTypechain", description: "skip typechain" }],
      };
      runner.registerTasks([task]);
      runner.setLre(makeLre());

      // Programmatic call with proper types
      await runner.run("compile", { timeout: 3000, noTypechain: true });

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 3000, noTypechain: true }),
        expect.anything(),
      );
    });

    it("preserves unrecognized args (e.g., _positional)", async () => {
      const action = vi.fn();
      const runner = new TaskRunnerImpl();
      const task: TaskDefinition = {
        id: "run",
        description: "run",
        action,
      };
      runner.registerTasks([task]);
      runner.setLre(makeLre());

      await runner.run("run", { _positional: ["script.ts"] });

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ _positional: ["script.ts"] }),
        expect.anything(),
      );
    });

    it("handles both kebab and camel keys for same flag", async () => {
      const action = vi.fn();
      const runner = new TaskRunnerImpl();
      const task: TaskDefinition = {
        id: "test",
        description: "test",
        action,
        flags: [
          { name: "skipConfirm", description: "skip" },
          { name: "noCompile", description: "no compile" },
        ],
      };
      runner.registerTasks([task]);
      runner.setLre(makeLre());

      // Mix of CLI and camelCase args
      await runner.run("test", { "skip-confirm": true, noCompile: true });

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ skipConfirm: true, noCompile: true }),
        expect.anything(),
      );
    });

    it("fills defaults for flags not provided in CLI args", async () => {
      const action = vi.fn();
      const runner = new TaskRunnerImpl();
      const task: TaskDefinition = {
        id: "test",
        description: "test",
        action,
        flags: [
          { name: "noCompile", description: "no compile" },
          { name: "prove", description: "prove" },
        ],
      };
      runner.registerTasks([task]);
      runner.setLre(makeLre());

      // Only pass --no-compile, not --prove
      await runner.run("test", { "no-compile": true });

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ noCompile: true, prove: false }),
        expect.anything(),
      );
    });

    it("does not coerce NaN results", async () => {
      const action = vi.fn();
      const runner = new TaskRunnerImpl();
      const task: TaskDefinition = {
        id: "test",
        description: "test",
        action,
        options: [{ name: "timeout", type: "number", description: "timeout" }],
      };
      runner.registerTasks([task]);
      runner.setLre(makeLre());

      await runner.run("test", { timeout: "not-a-number" });

      // Should keep the original string since Number("not-a-number") is NaN
      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: "not-a-number" }),
        expect.anything(),
      );
    });
  });

  describe("basic operations", () => {
    it("throws TaskNotFoundError for unknown task", async () => {
      const runner = new TaskRunnerImpl();
      runner.setLre(makeLre());

      await expect(runner.run("nonexistent")).rejects.toThrow(TaskNotFoundError);
    });

    it("runs registered task", async () => {
      const action = vi.fn().mockResolvedValue("result");
      const runner = new TaskRunnerImpl();
      runner.registerTasks([{ id: "hello", description: "hello", action }]);
      runner.setLre(makeLre());

      const result = await runner.run("hello");

      expect(result).toBe("result");
    });

    it("fills option defaults", async () => {
      const action = vi.fn();
      const runner = new TaskRunnerImpl();
      runner.registerTasks([{
        id: "test",
        description: "test",
        action,
        options: [{ name: "port", type: "number", description: "port", defaultValue: 3030 }],
      }]);
      runner.setLre(makeLre());

      await runner.run("test", {});

      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({ port: 3030 }),
        expect.anything(),
      );
    });
  });
});
