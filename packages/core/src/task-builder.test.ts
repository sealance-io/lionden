import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import { describe, expect, it, vi } from "vitest";
import { createLre } from "./lre.js";
import { overrideTask, task } from "./task-builder.js";
import { TaskRunnerImpl } from "./task-runner.js";
import type { LionDenPlugin, LionDenRuntimeEnvironment } from "./types.js";

const mockLre = {} as LionDenRuntimeEnvironment;

describe("task builder", () => {
  it("builds a task definition", () => {
    const def = task("compile", "Compile Leo programs")
      .addOption({
        name: "force",
        type: "boolean",
        defaultValue: false,
        description: "Force recompile",
      })
      .addFlag({ name: "noTypechain", description: "Skip codegen" })
      .setAction(async () => {})
      .build();

    expect(def.id).toBe("compile");
    expect(def.description).toBe("Compile Leo programs");
    expect(def.options).toHaveLength(1);
    expect(def.flags).toHaveLength(1);
  });

  it("throws if no action set", () => {
    expect(() => task("x", "").build()).toThrow('Task "x" has no action set');
  });
});

describe("task runner", () => {
  it("runs a simple task", async () => {
    const action = vi.fn(async () => "result");
    const def = task("test", "").setAction(action).build();

    const runner = new TaskRunnerImpl();
    runner.registerTasks([def]);
    runner.setLre(mockLre);

    const result = await runner.run("test");
    expect(action).toHaveBeenCalledOnce();
    expect(result).toBe("result");
  });

  it("fills default values", async () => {
    const action = vi.fn(async (args: Record<string, unknown>) => args);
    const def = task("test", "")
      .addOption({
        name: "force",
        type: "boolean",
        defaultValue: false,
        description: "",
      })
      .addFlag({ name: "verbose", description: "" })
      .setAction(action)
      .build();

    const runner = new TaskRunnerImpl();
    runner.registerTasks([def]);
    runner.setLre(mockLre);

    const result = (await runner.run("test")) as Record<string, unknown>;
    expect(result).toEqual({ force: false, verbose: false });
  });

  it("throws on unknown task", async () => {
    const runner = new TaskRunnerImpl();
    runner.setLre(mockLre);
    await expect(runner.run("nonexistent")).rejects.toThrow('Task "nonexistent" not found');
  });

  it("throws on duplicate task registration", () => {
    const def = task("x", "")
      .setAction(async () => {})
      .build();
    const runner = new TaskRunnerImpl();
    runner.registerTasks([def]);
    expect(() => runner.registerTasks([def])).toThrow('Task "x" is already registered');
  });

  it("supports task overrides with runSuper", async () => {
    const order: string[] = [];

    const original = task("compile", "")
      .setAction(async () => {
        order.push("original");
      })
      .build();

    const override = overrideTask("compile")
      .setAction(async (args, lre, runSuper) => {
        order.push("before");
        await runSuper(args);
        order.push("after");
      })
      .build();

    const runner = new TaskRunnerImpl();
    runner.registerTasks([original]);
    runner.registerTasks([override]);
    runner.setLre(mockLre);

    await runner.run("compile");
    expect(order).toEqual(["before", "original", "after"]);
  });

  it("runs dependency tasks before the main task", async () => {
    const order: string[] = [];

    const dep = task("dep", "")
      .setAction(async () => {
        order.push("dep");
      })
      .build();

    const main = task("main", "")
      .addDependency("dep")
      .setAction(async () => {
        order.push("main");
      })
      .build();

    const runner = new TaskRunnerImpl();
    runner.registerTasks([dep, main]);
    runner.setLre(mockLre);

    await runner.run("main");
    expect(order).toEqual(["dep", "main"]);
  });

  it("runs lazy task actions via setLazyAction", async () => {
    const action = vi.fn(async () => "lazy-result");
    const def = task("lazy", "")
      .setLazyAction(async () => ({ default: action }))
      .build();

    const runner = new TaskRunnerImpl();
    runner.registerTasks([def]);
    runner.setLre(mockLre);

    const result = await runner.run("lazy");
    expect(action).toHaveBeenCalledOnce();
    expect(result).toBe("lazy-result");
  });
});

describe("createLre config-level tasks", () => {
  const mockConfig = {
    leoVersion: "4.0.0",
    skipLeoVersionCheck: false,
    leoBinary: "leo",
    paths: {
      root: "/tmp",
      programs: "/tmp/programs",
      artifacts: "/tmp/artifacts",
      typechain: "/tmp/typechain",
      cache: "/tmp/cache",
      deployments: "/tmp/deployments",
    },
    networks: {},
    defaultNetwork: "devnode",
    compiler: { enableDce: true, conditionalBlockMaxDepth: 10, buildTests: false, extraFlags: [] },
    codegen: { enabled: true, outDir: "typechain", dynamicRecords: {} },
    testing: { framework: "vitest" as const, timeout: 120_000, autoStartDevnode: true },
    deploy: {
      defaultPriorityFee: 0,
      privateFee: false,
      confirmTransactions: true,
      confirmationTimeout: 60_000,
      deploymentsDir: "deployments",
      skipDeployed: true,
      autoExport: false,
    },
    sdk: { keyCache: { storage: "memory" as const } },
    execution: { imports: {} },
    namedAccounts: {},
  } satisfies LionDenResolvedConfig;

  it("registers config-level tasks alongside plugin tasks", async () => {
    const pluginTask = task("plugin-task", "from plugin")
      .setAction(async () => "plugin")
      .build();
    const plugin: LionDenPlugin = { id: "test-plugin", tasks: [pluginTask] };

    const configTask = task("config-task", "from config")
      .setAction(async () => "config")
      .build();

    const lre = createLre({
      config: mockConfig,
      plugins: [plugin],
      configTasks: [configTask],
    });

    expect(lre.tasks.has("plugin-task")).toBe(true);
    expect(lre.tasks.has("config-task")).toBe(true);

    const result = await lre.tasks.run("config-task");
    expect(result).toBe("config");
  });
});

describe("artifact store", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-artifacts-"));
  const mockConfig = {
    leoVersion: "4.0.0",
    skipLeoVersionCheck: false,
    leoBinary: "leo",
    paths: {
      root: tempRoot,
      programs: path.join(tempRoot, "programs"),
      artifacts: path.join(tempRoot, "artifacts"),
      typechain: path.join(tempRoot, "typechain"),
      cache: path.join(tempRoot, "cache"),
      deployments: path.join(tempRoot, "deployments"),
    },
    networks: {},
    defaultNetwork: "devnode",
    compiler: { enableDce: true, conditionalBlockMaxDepth: 10, buildTests: false, extraFlags: [] },
    codegen: { enabled: true, outDir: "typechain", dynamicRecords: {} },
    testing: { framework: "vitest" as const, timeout: 120_000, autoStartDevnode: true },
    deploy: {
      defaultPriorityFee: 0,
      privateFee: false,
      confirmTransactions: true,
      confirmationTimeout: 60_000,
      deploymentsDir: "deployments",
      skipDeployed: true,
      autoExport: false,
    },
    sdk: { keyCache: { storage: "memory" as const } },
    execution: { imports: {} },
    namedAccounts: {},
  } satisfies LionDenResolvedConfig;

  it("exposes setAbi/setAleoSource on the artifact store interface", () => {
    const lre = createLre({ config: mockConfig, plugins: [] });

    // Should be callable without type errors
    lre.artifacts.setAbi("hello.aleo", { program: "hello.aleo", transitions: [] });
    lre.artifacts.setAleoSource("hello.aleo", "program hello.aleo { }");

    expect(lre.artifacts.getAbi("hello.aleo")).toEqual({ program: "hello.aleo", transitions: [] });
    expect(lre.artifacts.getAleoSource("hello.aleo")).toBe("program hello.aleo { }");
    expect(lre.artifacts.getProgramIds()).toEqual(["hello.aleo"]);
  });

  it("hydrates artifacts from disk for a fresh LRE", () => {
    const artifactDir = path.join(mockConfig.paths.artifacts, "hello.aleo");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, "abi.json"),
      JSON.stringify({ program: "hello.aleo", transitions: ["main"] }),
    );
    fs.writeFileSync(path.join(artifactDir, "main.aleo"), "program hello.aleo { }");

    const lre = createLre({ config: mockConfig, plugins: [] });

    expect(lre.artifacts.getProgramIds()).toContain("hello.aleo");
    expect(lre.artifacts.getAbi("hello.aleo")).toEqual({
      program: "hello.aleo",
      transitions: ["main"],
    });
    expect(lre.artifacts.getAleoSource("hello.aleo")).toBe("program hello.aleo { }");
  });
});
