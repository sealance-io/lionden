import {
  ArgumentType,
  type GlobalOptionDefinition,
  type LionDenRuntimeEnvironment,
  type TaskDefinition,
} from "@lionden/core";
import { describe, expect, it } from "vitest";
import { parseArgs, validateParsedArgs } from "./task-dispatch.js";

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

  it("consumes a --network value that collides with a task id when a later task follows", () => {
    // A config network literally named "test" plus a registered "test" task:
    // `--network test deploy` must set network=test and run deploy, not run the
    // `test` task with `deploy` as a positional.
    const result = parseArgs(
      ["--network", "test", "deploy"],
      undefined,
      lookupFor(defineTask({ id: "test" }), defineTask({ id: "deploy" })),
    );
    expect(result.taskId).toBe("deploy");
    expect(result.globalArgs.network).toBe("test");
    expect(result.taskArgs._positional).toBeUndefined();
  });

  it("consumes a task-id-named option value for a valued plugin global too", () => {
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
      ["--env", "test", "deploy"],
      pluginOpts,
      lookupFor(defineTask({ id: "test" }), defineTask({ id: "deploy" })),
    );
    expect(result.taskId).toBe("deploy");
    expect(result.globalArgs.env).toBe("test");
    expect(result.taskArgs._positional).toBeUndefined();
  });

  it("treats a lone task-id-named --network value as the task (value-less, no later task)", () => {
    // No task token follows, so the value-less forgiveness still applies:
    // `--network test` runs the `test` task rather than swallowing it.
    const result = parseArgs(
      ["--network", "test"],
      undefined,
      lookupFor(defineTask({ id: "test" })),
    );
    expect(result.taskId).toBe("test");
    expect(result.globalArgs.network).toBeUndefined();
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

  it("records bare arguments before a later known task separately from positionals", () => {
    const result = parseArgs(
      ["hello", "compile"],
      undefined,
      lookupFor(defineTask({ id: "compile" })),
    );

    expect(result.taskId).toBe("compile");
    expect(result.preTaskArgs).toEqual(["hello"]);
    expect(result.taskArgs._positional).toBeUndefined();
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

  it("routes a named positional's value under its canonical name", () => {
    const result = parseArgs(
      ["run", "--script-path", "scripts/seed.ts"],
      undefined,
      lookupFor(
        defineTask({
          id: "run",
          positionalArguments: [{ name: "scriptPath", type: ArgumentType.FILE }],
        }),
      ),
    );

    expect(result.taskArgs.scriptPath).toBe("scripts/seed.ts");
  });

  it("does not store a value-less named positional as a boolean sentinel", () => {
    const result = parseArgs(
      ["run", "--script-path"],
      undefined,
      lookupFor(
        defineTask({
          id: "run",
          positionalArguments: [{ name: "scriptPath", type: ArgumentType.FILE }],
        }),
      ),
    );

    // A value-less `--script-path` must consume nothing — not land `true` — so
    // the positional stays unset and the runner's required check can fire.
    expect("scriptPath" in result.taskArgs).toBe(false);
    expect("script-path" in result.taskArgs).toBe(false);
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
      ["test", "test/file.test.ts", "--coverage"],
      undefined,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "coverage", description: "Collect coverage" }],
        }),
      ),
    );

    expect(result.taskArgs._positional).toEqual(["test/file.test.ts"]);
    expect(result.taskArgs.coverage).toBe(true);
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
        "trace",
        {
          pluginId: "test",
          definition: { name: "trace", description: "Enable tracing", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    const result = parseArgs(["--trace", "test"], pluginOpts);
    expect(result.globalArgs.trace).toBe(true);
    expect(result.taskId).toBe("test");
  });

  it("routes a boolean plugin global option placed AFTER the task into globalArgs without swallowing the next token", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "trace",
        {
          pluginId: "@lionden/plugin-deploy",
          definition: { name: "trace", description: "Enable tracing", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    const result = parseArgs(
      ["deploy", "--trace", "hello"],
      pluginOpts,
      lookupFor(
        defineTask({
          id: "deploy",
          options: [{ name: "program", type: "string", description: "Program name" }],
        }),
      ),
    );

    // --trace is recorded as a global (like its pre-task form), NOT as a task arg…
    expect(result.globalArgs.trace).toBe(true);
    expect(result.taskArgs.trace).toBeUndefined();
    // …and "hello" survives as a positional instead of being eaten as trace's value.
    expect(result.taskArgs._positional).toEqual(["hello"]);
  });

  it("routes a boolean global by name even when placed after a task", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "trace",
        {
          pluginId: "@lionden/plugin-deploy",
          definition: { name: "trace", description: "Enable tracing", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    const result = parseArgs(
      ["test", "--trace", "extra"],
      pluginOpts,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "noCompile", description: "Skip compile" }],
        }),
      ),
    );

    expect(result.globalArgs.trace).toBe(true);
    expect(result.taskArgs.trace).toBeUndefined();
    expect(result.taskArgs._positional).toEqual(["extra"]);
  });

  it("routes a plugin global to the active task when the task defines a flag of the same name", () => {
    const pluginOpts = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "trace",
        {
          pluginId: "@lionden/plugin-deploy",
          definition: { name: "trace", description: "Enable tracing", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    const result = parseArgs(
      ["test", "--trace"],
      pluginOpts,
      lookupFor(
        defineTask({
          id: "test",
          flags: [{ name: "trace", description: "Enable tracing" }],
        }),
      ),
    );

    expect(result.taskArgs.trace).toBe(true);
    expect(result.globalArgs.trace).toBeUndefined();
  });

  describe("built-in --prove routing", () => {
    it("routes --prove before the task into globalArgs and keeps the task token", () => {
      const result = parseArgs(
        ["--prove", "test"],
        undefined,
        lookupFor(defineTask({ id: "test" })),
      );
      expect(result.globalArgs.prove).toBe(true);
      expect(result.taskId).toBe("test");
    });

    it("routes --prove after the task into globalArgs (built-in, not a task arg)", () => {
      const result = parseArgs(
        ["test", "--prove", "extra"],
        undefined,
        lookupFor(
          defineTask({
            id: "test",
            flags: [{ name: "noCompile", description: "Skip compile" }],
          }),
        ),
      );
      expect(result.globalArgs.prove).toBe(true);
      expect(result.taskArgs.prove).toBeUndefined();
      // boolean built-in does not consume the next token
      expect(result.taskArgs._positional).toEqual(["extra"]);
    });

    it("interprets --prove=false as an explicit false", () => {
      const result = parseArgs(
        ["deploy", "--prove=false"],
        undefined,
        lookupFor(defineTask({ id: "deploy" })),
      );
      expect(result.globalArgs.prove).toBe(false);
    });

    it("keeps the last value for a repeated --prove (last write wins)", () => {
      const result = parseArgs(
        ["--prove", "--prove=false", "deploy"],
        undefined,
        lookupFor(defineTask({ id: "deploy" })),
      );
      expect(result.globalArgs.prove).toBe(false);
    });

    it("wins over a task that raw-defines a prove arg (built-in is reserved)", () => {
      // TaskBuilder rejects a `prove` arg, but a raw TaskDefinition can still
      // carry one; the built-in global must take precedence during routing.
      const result = parseArgs(
        ["test", "--prove"],
        undefined,
        lookupFor(
          defineTask({
            id: "test",
            flags: [{ name: "prove", description: "Enable proofs" }],
          }),
        ),
      );
      expect(result.globalArgs.prove).toBe(true);
      expect(result.taskArgs.prove).toBeUndefined();
    });
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

  describe("inline --opt=value", () => {
    const traceGlobal = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "trace",
        {
          pluginId: "@lionden/plugin-deploy",
          definition: { name: "trace", description: "Trace", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    it("applies an inline value to a valued global (--network=testnet)", () => {
      const result = parseArgs(
        ["--network=testnet", "deploy"],
        undefined,
        lookupFor(defineTask({ id: "deploy" })),
      );
      expect(result.taskId).toBe("deploy");
      expect(result.globalArgs.network).toBe("testnet");
      expect("network=testnet" in result.taskArgs).toBe(false);
    });

    it("applies an inline valued global after the task name too", () => {
      const result = parseArgs(["deploy", "--network=testnet"]);
      expect(result.globalArgs.network).toBe("testnet");
    });

    it("does not consume the following token when the option is inline", () => {
      // `--network=test deploy`: a network literally named "test" supplied inline,
      // with `test` ALSO a registered task — the inline value must win and `deploy`
      // must remain the task.
      const result = parseArgs(
        ["--network=test", "deploy"],
        undefined,
        lookupFor(defineTask({ id: "test" }), defineTask({ id: "deploy" })),
      );
      expect(result.taskId).toBe("deploy");
      expect(result.globalArgs.network).toBe("test");
    });

    it("applies inline values to known valued task options", () => {
      const result = parseArgs(
        ["deploy", "--program=hello"],
        undefined,
        lookupFor(
          defineTask({
            id: "deploy",
            options: [{ name: "program", type: "string", description: "" }],
          }),
        ),
      );
      expect(result.taskArgs.program).toBe("hello");
    });

    it("splits on the first = so values may contain =", () => {
      const result = parseArgs(
        ["deploy", "--program=a=b"],
        undefined,
        lookupFor(
          defineTask({
            id: "deploy",
            options: [{ name: "program", type: "string", description: "" }],
          }),
        ),
      );
      expect(result.taskArgs.program).toBe("a=b");
    });

    it("interprets =false / =true / presence for boolean globals", () => {
      expect(parseArgs(["deploy", "--trace=false"], traceGlobal).globalArgs.trace).toBe(false);
      expect(parseArgs(["deploy", "--trace=true"], traceGlobal).globalArgs.trace).toBe(true);
      expect(parseArgs(["deploy", "--trace"], traceGlobal).globalArgs.trace).toBe(true);
    });

    it("keeps an unknown inline option's value instead of a bogus key", () => {
      const result = parseArgs(
        ["deploy", "--foo=bar"],
        undefined,
        lookupFor(defineTask({ id: "deploy" })),
      );
      expect(result.taskArgs.foo).toBe("bar");
      expect("foo=bar" in result.taskArgs).toBe(false);
    });
  });

  describe("duplicate args — last write wins", () => {
    const traceGlobal = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>([
      [
        "trace",
        {
          pluginId: "@lionden/plugin-deploy",
          definition: { name: "trace", description: "Trace", type: ArgumentType.BOOLEAN },
        },
      ],
    ]);

    it("keeps the last value for a repeated valued global (--network)", () => {
      const result = parseArgs(
        ["--network=a", "--network=b", "deploy"],
        undefined,
        lookupFor(defineTask({ id: "deploy" })),
      );
      expect(result.globalArgs.network).toBe("b");
    });

    it("keeps the last value for a repeated boolean global (--trace --trace=false)", () => {
      const result = parseArgs(["deploy", "--trace", "--trace=false"], traceGlobal);
      expect(result.globalArgs.trace).toBe(false);
    });

    it("keeps the last value for a repeated valued task option (--grep)", () => {
      const result = parseArgs(
        ["test", "--grep=a", "--grep=b"],
        undefined,
        lookupFor(
          defineTask({
            id: "test",
            options: [{ name: "grep", type: "string", description: "Filter" }],
          }),
        ),
      );
      expect(result.taskArgs.grep).toBe("b");
    });

    it("collapses camelCase and kebab-case spellings of the same task option", () => {
      const result = parseArgs(
        ["deploy", "--priority-fee=1", "--priorityFee=2"],
        undefined,
        lookupFor(
          defineTask({
            id: "deploy",
            options: [{ name: "priorityFee", type: "number", description: "Priority fee" }],
          }),
        ),
      );
      expect(result.taskArgs.priorityFee).toBe("2");
    });
  });
});

describe("validateParsedArgs", () => {
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

  function lreFor(...definitions: TaskDefinition[]): LionDenRuntimeEnvironment {
    const lookup = lookupFor(...definitions);
    return {
      tasks: {
        getTaskDefinition: lookup,
      },
    } as unknown as LionDenRuntimeEnvironment;
  }

  it("accepts declared task options, flags, positionals, and raw _positional values", () => {
    const lre = lreFor(
      defineTask({
        id: "run",
        options: [{ name: "priorityFee", type: "number", description: "Fee" }],
        flags: [{ name: "dryRun", description: "Dry run" }],
        positionalArguments: [{ name: "scriptPath", type: ArgumentType.FILE }],
      }),
    );
    const parsed = parseArgs(
      ["run", "--priority-fee", "10", "--dry-run", "--script-path", "scripts/deploy.ts"],
      undefined,
      (taskId) => lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).not.toThrow();
  });

  it("rejects an unknown task", () => {
    const lre = lreFor(defineTask({ id: "compile" }));
    const parsed = parseArgs(["missing"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).toThrow(
      `Unknown task: "missing". Run 'lionden --help' to see available tasks.`,
    );
  });

  it("rejects an unknown argument when no task was selected", () => {
    const lre = lreFor();
    const parsed = parseArgs(["--bogus"]);

    expect(() => validateParsedArgs(lre, parsed)).toThrow('Unknown argument "--bogus"');
  });

  it("rejects an unknown argument for a known task", () => {
    const lre = lreFor(
      defineTask({
        id: "test",
        flags: [{ name: "noCompile", description: "Skip compile" }],
      }),
    );
    const parsed = parseArgs(["test", "--unknown", "test/file.test.ts"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).toThrow(
      'Unknown argument "--unknown" for task "test"',
    );
  });

  it("rejects a bare argument before a later known task", () => {
    const lre = lreFor(defineTask({ id: "compile" }));
    const parsed = parseArgs(["hello", "compile"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).toThrow(
      'Unexpected argument "hello" before task "compile"',
    );
  });

  it("rejects a bare argument after a task with no positional arguments", () => {
    const lre = lreFor(defineTask({ id: "compile" }));
    const parsed = parseArgs(["compile", "hello"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).toThrow(
      'Unexpected argument "hello" for task "compile"',
    );
  });

  it("rejects more bare arguments than declared positionals", () => {
    const lre = lreFor(
      defineTask({
        id: "run",
        positionalArguments: [{ name: "script", type: ArgumentType.FILE }],
      }),
    );
    const parsed = parseArgs(["run", "scripts/deploy.ts", "extra"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).toThrow(
      'Unexpected argument "extra" for task "run"',
    );
  });

  it("rejects a bare argument that overflows the positionals left unbound by a named one", () => {
    const lre = lreFor(
      defineTask({
        id: "pair",
        positionalArguments: [
          { name: "first", type: ArgumentType.STRING },
          { name: "second", type: ArgumentType.STRING },
        ],
      }),
    );
    // `--first` consumes "named", leaving only `second` unbound; the bare values
    // "x" and "y" then exceed the single remaining slot, so "y" overflows.
    const parsed = parseArgs(["pair", "--first", "named", "x", "y"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).toThrow(
      'Unexpected argument "y" for task "pair"',
    );
  });

  it("accepts bare arguments that exactly fill the positionals left unbound by a named one", () => {
    const lre = lreFor(
      defineTask({
        id: "pair",
        positionalArguments: [
          { name: "first", type: ArgumentType.STRING },
          { name: "second", type: ArgumentType.STRING },
        ],
      }),
    );
    // `--first` fills `first`; the single bare value "x" fills `second` exactly.
    const parsed = parseArgs(["pair", "--first", "named", "x"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).not.toThrow();
  });

  it("allows multiple bare arguments for a variadic positional", () => {
    const lre = lreFor(
      defineTask({
        id: "test",
        positionalArguments: [{ name: "files", type: ArgumentType.FILE, variadic: true }],
      }),
    );
    const parsed = parseArgs(["test", "a.test.ts", "b.test.ts"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).not.toThrow();
  });

  it("rejects an unknown option placed before a known task", () => {
    const lre = lreFor(defineTask({ id: "compile" }));
    const parsed = parseArgs(["--bogus", "compile"], undefined, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );

    expect(() => validateParsedArgs(lre, parsed)).toThrow(
      'Unknown argument "--bogus" for task "compile"',
    );
  });

  it("does not reject known global options placed before or after the task", () => {
    const lre = lreFor(defineTask({ id: "compile" }));
    const lookup = (taskId: string) => lre.tasks.getTaskDefinition(taskId);

    const globalBefore = parseArgs(["--verbose", "compile"], undefined, lookup);
    const globalAfter = parseArgs(["compile", "--network", "testnet"], undefined, lookup);

    expect(() => validateParsedArgs(lre, globalBefore)).not.toThrow();
    expect(() => validateParsedArgs(lre, globalAfter)).not.toThrow();
  });
});
