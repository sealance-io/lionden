import { describe, it, expect } from "vitest";
import {
  ArgumentType,
  type GlobalOptionDefinition,
  type TaskDefinition,
} from "@lionden/core";
import { parseArgs } from "./task-dispatch.js";

describe("parseArgs", () => {
  function defineTask(
    definition: Pick<TaskDefinition, "id"> & Partial<TaskDefinition>,
  ): TaskDefinition {
    return {
      description: "Test task",
      action: async () => undefined,
      ...definition,
    };
  }

  function lookupFor(
    ...definitions: TaskDefinition[]
  ): (taskId: string) => TaskDefinition | undefined {
    const byId = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
    return (taskId) => byId.get(taskId);
  }

  it("returns null taskId for empty argv", () => {
    const result = parseArgs([]);
    expect(result.taskId).toBeNull();
    expect(result.taskArgs).toEqual({});
    expect(result.globalArgs).toEqual({});
  });

  it("parses --help flag", () => {
    expect(parseArgs(["--help"]).globalArgs.help).toBe(true);
  });

  it("parses -h shorthand", () => {
    expect(parseArgs(["-h"]).globalArgs.help).toBe(true);
  });

  it("parses --version flag", () => {
    expect(parseArgs(["--version"]).globalArgs.version).toBe(true);
  });

  it("parses -v shorthand", () => {
    expect(parseArgs(["-v"]).globalArgs.version).toBe(true);
  });

  it("parses --verbose flag", () => {
    expect(parseArgs(["--verbose"]).globalArgs.verbose).toBe(true);
  });

  it("parses --config with value", () => {
    const result = parseArgs(["--config", "my.config.ts"]);
    expect(result.globalArgs.config).toBe("my.config.ts");
  });

  it("parses --network with value", () => {
    const result = parseArgs(["--network", "testnet"]);
    expect(result.globalArgs.network).toBe("testnet");
  });

  it("identifies task name as first non-flag argument", () => {
    const result = parseArgs(["compile"]);
    expect(result.taskId).toBe("compile");
  });

  it("parses task arguments after task name", () => {
    const result = parseArgs(["deploy", "--program", "hello", "--priorityFee", "100"]);
    expect(result.taskId).toBe("deploy");
    expect(result.taskArgs).toEqual({ program: "hello", priorityFee: "100" });
  });

  it("treats --flag without value as boolean true", () => {
    const result = parseArgs(["compile", "--force"]);
    expect(result.taskArgs["force"]).toBe(true);
  });

  it("treats --flag before another --flag as boolean", () => {
    const result = parseArgs(["deploy", "--skipConfirm", "--program", "hello"]);
    expect(result.taskArgs["skipConfirm"]).toBe(true);
    expect(result.taskArgs["program"]).toBe("hello");
  });

  it("collects positional task arguments into _positional array", () => {
    const result = parseArgs(["run", "scripts/seed.ts", "extra"]);
    expect(result.taskArgs["_positional"]).toEqual(["scripts/seed.ts", "extra"]);
  });

  it("keeps positionals after known boolean task flags", () => {
    const result = parseArgs(
      ["test", "--no-compile", "test/skip-devnode.test.ts"],
      undefined,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "noCompile", description: "Skip compile" }],
        }),
      ),
    );

    expect(result.taskArgs["no-compile"]).toBe(true);
    expect(result.taskArgs["_positional"]).toEqual(["test/skip-devnode.test.ts"]);
  });

  it("keeps positionals before known boolean task flags", () => {
    const result = parseArgs(
      ["test", "test/file.test.ts", "--prove"],
      undefined,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "prove", description: "Enable proofs" }],
        }),
      ),
    );

    expect(result.taskArgs["_positional"]).toEqual(["test/file.test.ts"]);
    expect(result.taskArgs["prove"]).toBe(true);
  });

  it("keeps positionals after known boolean task options", () => {
    const result = parseArgs(
      ["compile", "--force", "programs/hello"],
      undefined,
      lookupFor(
        defineTask({
          id: "compile",
          options: [
            { name: "force", type: "boolean", description: "Force compile" },
          ],
        }),
      ),
    );

    expect(result.taskArgs["force"]).toBe(true);
    expect(result.taskArgs["_positional"]).toEqual(["programs/hello"]);
  });

  it("continues to consume values for known string and number task options", () => {
    const result = parseArgs(
      ["deploy", "--program", "hello", "--priority-fee", "100"],
      undefined,
      lookupFor(
        defineTask({
          id: "deploy",
          options: [
            { name: "program", type: "string", description: "Program name" },
            { name: "priorityFee", type: "number", description: "Priority fee" },
          ],
        }),
      ),
    );

    expect(result.taskArgs).toEqual({ program: "hello", "priority-fee": "100" });
  });

  it("preserves greedy fallback for unknown tasks", () => {
    const result = parseArgs(
      ["missing", "--no-compile", "test/file.test.ts"],
      undefined,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "noCompile", description: "Skip compile" }],
        }),
      ),
    );

    expect(result.taskArgs).toEqual({ "no-compile": "test/file.test.ts" });
  });

  it("preserves greedy fallback for unknown options on known tasks", () => {
    const result = parseArgs(
      ["test", "--unknown", "test/file.test.ts"],
      undefined,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "noCompile", description: "Skip compile" }],
        }),
      ),
    );

    expect(result.taskArgs).toEqual({ unknown: "test/file.test.ts" });
  });

  it("separates global options from task options", () => {
    const result = parseArgs(["--config", "path.ts", "--verbose", "compile", "--force"]);
    expect(result.globalArgs.config).toBe("path.ts");
    expect(result.globalArgs.verbose).toBe(true);
    expect(result.taskId).toBe("compile");
    expect(result.taskArgs["force"]).toBe(true);
  });

  it("parses boolean plugin global option", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      ["prove", { pluginId: "test", definition: { name: "prove", description: "Enable proofs", type: ArgumentType.BOOLEAN } }],
    ]);

    const result = parseArgs(["--prove", "test"], pluginOpts);
    expect(result.globalArgs["prove"]).toBe(true);
    expect(result.taskId).toBe("test");
  });

  it("parses string plugin global option", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      ["env", { pluginId: "core", definition: { name: "env", description: "Environment", type: ArgumentType.STRING } }],
    ]);

    const result = parseArgs(["--env", "production", "deploy"], pluginOpts);
    expect(result.globalArgs["env"]).toBe("production");
    expect(result.taskId).toBe("deploy");
  });
});
