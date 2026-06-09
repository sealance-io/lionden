import { ArgumentType, type GlobalOptionDefinition, type TaskDefinition } from "@lionden/core";
import { describe, expect, it } from "vitest";
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
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
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

  it("does not let --config consume a known task token during discovery", () => {
    const result = parseArgs(
      ["--config", "compile"],
      undefined,
      lookupFor(defineTask({ id: "compile" })),
    );
    expect(result.taskId).toBe("compile");
    expect(result.globalArgs.config).toBeUndefined();
  });

  it("still consumes a real --config value before a known task", () => {
    const result = parseArgs(
      ["--config", "lionden.config.ts", "compile"],
      undefined,
      lookupFor(defineTask({ id: "compile" })),
    );
    expect(result.taskId).toBe("compile");
    expect(result.globalArgs.config).toBe("lionden.config.ts");
  });

  it("parses --network with value", () => {
    const result = parseArgs(["--network", "testnet"]);
    expect(result.globalArgs.network).toBe("testnet");
  });

  it("does not let --network consume a known task token during discovery", () => {
    const result = parseArgs(
      ["--network", "deploy"],
      undefined,
      lookupFor(defineTask({ id: "deploy" })),
    );
    expect(result.taskId).toBe("deploy");
    expect(result.globalArgs.network).toBeUndefined();
  });

  it("still consumes a real --network value before a known task", () => {
    const result = parseArgs(
      ["--network", "testnet", "deploy"],
      undefined,
      lookupFor(defineTask({ id: "deploy" })),
    );
    expect(result.taskId).toBe("deploy");
    expect(result.globalArgs.network).toBe("testnet");
  });

  it("routes --network after the task name into globalArgs", () => {
    const result = parseArgs(["deploy", "--network", "testnet"]);
    expect(result.globalArgs.network).toBe("testnet");
    expect(result.taskArgs.network).toBeUndefined();
  });

  it("keeps --network global-only even without a value", () => {
    const result = parseArgs(["deploy", "--network"]);
    expect(result.globalArgs.network).toBeUndefined();
    expect(result.taskArgs.network).toBeUndefined();
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

  it("routes task arguments by name even before the task name", () => {
    const result = parseArgs(
      ["--program", "hello", "deploy", "--network", "testnet"],
      undefined,
      lookupFor(
        defineTask({
          id: "deploy",
          options: [{ name: "program", type: "string", description: "Program name" }],
        }),
      ),
    );

    expect(result.taskId).toBe("deploy");
    expect(result.taskArgs).toEqual({ program: "hello" });
    expect(result.globalArgs.network).toBe("testnet");
  });

  it("treats --flag without value as boolean true", () => {
    const result = parseArgs(["compile", "--force"]);
    expect(result.taskArgs.force).toBe(true);
  });

  it("treats --flag before another --flag as boolean", () => {
    const result = parseArgs(["deploy", "--skipConfirm", "--program", "hello"]);
    expect(result.taskArgs.skipConfirm).toBe(true);
    expect(result.taskArgs.program).toBe("hello");
  });

  it("collects positional task arguments into _positional array", () => {
    const result = parseArgs(["run", "scripts/seed.ts", "extra"]);
    expect(result.taskArgs._positional).toEqual(["scripts/seed.ts", "extra"]);
  });

  it("skips only the actual task token occurrence", () => {
    const result = parseArgs(["run", "run"], undefined, lookupFor(defineTask({ id: "run" })));
    expect(result.taskId).toBe("run");
    expect(result.taskArgs._positional).toEqual(["run"]);
  });

  it("keeps later positional tokens that match the task id", () => {
    const result = parseArgs(
      ["run", "run", "extra"],
      undefined,
      lookupFor(defineTask({ id: "run" })),
    );
    expect(result.taskArgs._positional).toEqual(["run", "extra"]);
  });

  it("keeps repeated task-id positionals while routing global network after the task", () => {
    const result = parseArgs(
      ["run", "run", "--network", "testnet"],
      undefined,
      lookupFor(defineTask({ id: "run" })),
    );
    expect(result.taskArgs._positional).toEqual(["run"]);
    expect(result.globalArgs.network).toBe("testnet");
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

    expect(result.taskArgs.noCompile).toBe(true);
    expect(result.taskArgs._positional).toEqual(["test/skip-devnode.test.ts"]);
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

    expect(result.taskArgs._positional).toEqual(["test/file.test.ts"]);
    expect(result.taskArgs.prove).toBe(true);
  });

  it("keeps positionals after known boolean task flags", () => {
    const result = parseArgs(
      ["compile", "--force", "programs/hello"],
      undefined,
      lookupFor(
        defineTask({
          id: "compile",
          flags: [{ name: "force", description: "Force compile" }],
        }),
      ),
    );

    expect(result.taskArgs.force).toBe(true);
    expect(result.taskArgs._positional).toEqual(["programs/hello"]);
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

    expect(result.taskArgs).toEqual({ program: "hello", priorityFee: "100" });
  });

  it("does not let a known valued task option consume another option token", () => {
    const result = parseArgs(
      ["deploy", "--program", "--network", "testnet"],
      undefined,
      lookupFor(
        defineTask({
          id: "deploy",
          options: [{ name: "program", type: "string", description: "Program name" }],
        }),
      ),
    );

    expect(result.taskArgs.program).toBeUndefined();
    expect(result.globalArgs.network).toBe("testnet");
  });

  it("still lets a known valued task option consume a real value before a global option", () => {
    const result = parseArgs(
      ["deploy", "--program", "hello", "--network", "testnet"],
      undefined,
      lookupFor(
        defineTask({
          id: "deploy",
          options: [{ name: "program", type: "string", description: "Program name" }],
        }),
      ),
    );

    expect(result.taskArgs.program).toBe("hello");
    expect(result.globalArgs.network).toBe("testnet");
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
    expect(result.taskArgs.force).toBe(true);
  });

  it("parses boolean plugin global option", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "prove",
        {
          pluginId: "test",
          definition: { name: "prove", description: "Enable proofs", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    const result = parseArgs(["--prove", "test"], pluginOpts);
    expect(result.globalArgs.prove).toBe(true);
    expect(result.taskId).toBe("test");
  });

  it("routes a boolean plugin global option placed AFTER the task into globalArgs without swallowing the next token", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "prove",
        {
          pluginId: "@lionden/plugin-deploy",
          definition: { name: "prove", description: "Enable proofs", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    const result = parseArgs(
      ["deploy", "--prove", "hello"],
      pluginOpts,
      lookupFor(
        defineTask({
          id: "deploy",
          options: [{ name: "program", type: "string", description: "Program name" }],
        }),
      ),
    );

    // --prove is recorded as a global (like its pre-task form), NOT as a task arg…
    expect(result.globalArgs.prove).toBe(true);
    expect(result.taskArgs.prove).toBeUndefined();
    // …and "hello" survives as a positional instead of being eaten as prove's value.
    expect(result.taskArgs._positional).toEqual(["hello"]);
  });

  it("routes a boolean global by name even when placed after a task", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "prove",
        {
          pluginId: "@lionden/plugin-deploy",
          definition: { name: "prove", description: "Enable proofs", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    const result = parseArgs(
      ["test", "--prove", "extra"],
      pluginOpts,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "noCompile", description: "Skip compile" }],
        }),
      ),
    );

    expect(result.globalArgs.prove).toBe(true);
    expect(result.taskArgs.prove).toBeUndefined();
    expect(result.taskArgs._positional).toEqual(["extra"]);
  });

  it("routes --prove to the active task when the task defines a prove flag", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "prove",
        {
          pluginId: "@lionden/plugin-deploy",
          definition: { name: "prove", description: "Enable proofs", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    const result = parseArgs(
      ["test", "--prove"],
      pluginOpts,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "prove", description: "Enable proofs" }],
        }),
      ),
    );

    expect(result.taskArgs.prove).toBe(true);
    expect(result.globalArgs.prove).toBeUndefined();
  });

  it("routes valued globals after the task by name", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "env",
        {
          pluginId: "core",
          definition: { name: "env", description: "Environment", type: ArgumentType.STRING },
        },
      ],
    ]);

    const result = parseArgs(
      ["deploy", "--env", "prod"],
      pluginOpts,
      lookupFor(defineTask({ id: "deploy" })),
    );

    expect(result.globalArgs.env).toBe("prod");
    expect(result.taskArgs.env).toBeUndefined();
  });

  it("leaves a missing valued plugin global unset", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "env",
        {
          pluginId: "core",
          definition: { name: "env", description: "Environment", type: ArgumentType.STRING },
        },
      ],
    ]);

    const result = parseArgs(
      ["deploy", "--env"],
      pluginOpts,
      lookupFor(defineTask({ id: "deploy" })),
    );

    expect(result.globalArgs.env).toBeUndefined();
    expect(result.taskArgs.env).toBeUndefined();
  });

  it("parses string plugin global option", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "env",
        {
          pluginId: "core",
          definition: { name: "env", description: "Environment", type: ArgumentType.STRING },
        },
      ],
    ]);

    const result = parseArgs(["--env", "production", "deploy"], pluginOpts);
    expect(result.globalArgs.env).toBe("production");
    expect(result.taskId).toBe("deploy");
  });
});
