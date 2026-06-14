/**
 * Tier 2 contract test — crosses: @lionden/cli + @lionden/core + @lionden/config
 *
 * Tests the CLI boot path end-to-end: config discovery → config loading from
 * disk → plugin resolution → config resolution → LRE creation → task dispatch.
 * Uses real loadConfigFile() against temp .ts config files on disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenUserConfig } from "@lionden/config";
import {
  ArgumentType,
  collectGlobalOptions,
  createLre,
  type LionDenPlugin,
  resolveConfig,
  resolvePluginOrder,
  task,
} from "@lionden/core";
import { type TempProject, TempProjectBuilder } from "@lionden/test-internals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findConfigFile, loadConfigFile } from "./config-discovery.js";
import { main } from "./index.js";
import { dispatchTask, parseArgs, validateTaskGlobalOptionCollisions } from "./task-dispatch.js";

describe("CLI dispatch contract", () => {
  let project: TempProject;

  afterEach(() => {
    project?.cleanup();
  });

  function createTempProject(configContent: string): string {
    project = new TempProjectBuilder().withConfig(configContent).build();
    return project.root;
  }

  it("discovers and loads config from disk, then dispatches task", async () => {
    const actionCalls: Record<string, unknown>[] = [];

    const testPlugin: LionDenPlugin = {
      id: "test-contract-plugin",
      name: "Contract Test Plugin",
      tasks: [
        task("greet", "Say hello")
          .addOption({ name: "name", type: "string", description: "Who to greet" })
          .setAction(async (args) => {
            actionCalls.push(args);
          })
          .build(),
      ],
    };

    // Write a real config file that defineConfig would produce
    const projectDir = createTempProject(`export default { leoVersion: "4.0.0" };`);

    // 1. Config discovery — real findConfigFile
    const configPath = findConfigFile(projectDir);
    expect(configPath).not.toBeNull();
    expect(configPath).toBe(path.join(projectDir, "lionden.config.ts"));

    // 2. Load config from disk — real loadConfigFile (dynamic import)
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath!);
    expect(projectRoot).toBe(projectDir);

    // Verify the loaded config shape
    const userConfig = rawConfig as LionDenUserConfig;
    expect(userConfig.leoVersion).toBe("4.0.0");

    // 3. Resolve plugins + parse args
    const plugins = resolvePluginOrder([testPlugin]);
    const globalOptionDefs = collectGlobalOptions(plugins);
    const parsed = parseArgs(["greet", "--name", "world"], globalOptionDefs);

    // 4. Resolve config through lifecycle
    const { resolved } = await resolveConfig(userConfig, plugins, projectRoot);
    expect(resolved.paths.root).toBe(projectDir);
    expect(resolved.leoVersion).toBe("4.0.0");

    // 5. Create LRE + dispatch
    const lre = createLre({ config: resolved, plugins });
    await dispatchTask(lre, parsed);

    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0]!["name"]).toBe("world");
  });

  it("reparses with LRE task metadata before dispatch", async () => {
    const actionCalls: Record<string, unknown>[] = [];

    const testPlugin: LionDenPlugin = {
      id: "test-contract-plugin",
      name: "Contract Test Plugin",
      tasks: [
        task("test", "Run tests")
          .addFlag({ name: "noCompile", description: "Skip compile" })
          .setAction(async (args) => {
            actionCalls.push(args);
          })
          .build(),
      ],
    };

    const projectDir = createTempProject(`export default { leoVersion: "4.0.0" };`);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);
    const plugins = resolvePluginOrder([testPlugin]);
    const globalOptionDefs = collectGlobalOptions(plugins);

    const firstParsed = parseArgs(
      ["test", "--no-compile", "test/skip-devnode.test.ts"],
      globalOptionDefs,
    );
    expect(firstParsed.taskArgs).toEqual({
      "no-compile": "test/skip-devnode.test.ts",
    });

    const { resolved } = await resolveConfig(rawConfig as LionDenUserConfig, plugins, projectRoot);
    const lre = createLre({ config: resolved, plugins });
    const parsed = parseArgs(
      ["test", "--no-compile", "test/skip-devnode.test.ts"],
      globalOptionDefs,
      (taskId) => lre.tasks.getTaskDefinition(taskId),
    );

    await dispatchTask(lre, parsed);

    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0]).toEqual(
      expect.objectContaining({
        noCompile: true,
        _positional: ["test/skip-devnode.test.ts"],
      }),
    );
  });

  it("loadConfigFile handles default export shape correctly", async () => {
    // Export an object with custom fields
    const projectDir = createTempProject(
      `export default { defaultNetwork: "testnet", codegen: { enabled: false } };`,
    );

    const configPath = findConfigFile(projectDir)!;
    const { config, projectRoot } = await loadConfigFile(configPath);

    expect(projectRoot).toBe(projectDir);
    const userConfig = config as LionDenUserConfig;
    expect(userConfig.defaultNetwork).toBe("testnet");
    expect(userConfig.codegen?.enabled).toBe(false);
  });

  it("loadConfigFile derives projectRoot from config path", async () => {
    const projectDir = createTempProject(`export default {};`);
    const nested = path.join(projectDir, "packages", "core");
    fs.mkdirSync(nested, { recursive: true });

    // Config is in projectDir, discovery starts from nested dir
    const configPath = findConfigFile(nested);
    expect(configPath).not.toBeNull();

    const { projectRoot } = await loadConfigFile(configPath!);
    // projectRoot should be the directory containing the config file
    expect(projectRoot).toBe(projectDir);
  });

  it("plugin hooks execute during config resolution", async () => {
    const hookCalls: string[] = [];

    const hookPlugin: LionDenPlugin = {
      id: "hook-test",
      name: "Hook Tester",
      hookHandlers: {
        config: {
          extendUserConfig(config) {
            hookCalls.push("extend");
            return config;
          },
          validateUserConfig() {
            hookCalls.push("validateUser");
            return [];
          },
          validateResolvedConfig() {
            hookCalls.push("validateResolved");
            return [];
          },
        },
      },
    };

    const projectDir = createTempProject(`export default {};`);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);

    const plugins = resolvePluginOrder([hookPlugin]);
    await resolveConfig(rawConfig as LionDenUserConfig, plugins, projectRoot);

    expect(hookCalls).toEqual(["extend", "validateUser", "validateResolved"]);
  });

  it("config resolution rejects invalid config via plugin hook", async () => {
    const rejectPlugin: LionDenPlugin = {
      id: "reject-test",
      name: "Rejector",
      hookHandlers: {
        config: {
          validateUserConfig() {
            return [{ path: "foo", message: "bar" }];
          },
        },
      },
    };

    const projectDir = createTempProject(`export default {};`);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);

    const plugins = resolvePluginOrder([rejectPlugin]);
    await expect(
      resolveConfig(rawConfig as LionDenUserConfig, plugins, projectRoot),
    ).rejects.toThrow("Config validation failed");
  });

  it("global options flow through to LRE", async () => {
    const testPlugin: LionDenPlugin = {
      id: "global-opts-test",
      name: "Global Opts",
      globalOptions: [{ name: "trace", description: "Enable tracing", type: ArgumentType.BOOLEAN }],
      tasks: [],
    };

    const projectDir = createTempProject(`export default {};`);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);

    const plugins = resolvePluginOrder([testPlugin]);
    const globalOptionDefs = collectGlobalOptions(plugins);

    const parsed = parseArgs(["--trace"], globalOptionDefs);
    expect(parsed.globalArgs["trace"]).toBe(true);

    const { resolved } = await resolveConfig(rawConfig as LionDenUserConfig, plugins, projectRoot);
    const globalOptions: Record<string, unknown> = {};
    for (const [name] of globalOptionDefs) {
      if (name in parsed.globalArgs) {
        globalOptions[name] = (parsed.globalArgs as Record<string, unknown>)[name];
      }
    }

    const lre = createLre({ config: resolved, plugins, globalOptions });
    expect(lre.globalOptions.trace).toBe(true);
  });

  it("renders help before validating an unknown --network override", async () => {
    const projectDir = createTempProject(
      `export default { defaultNetwork: "local", networks: { local: { type: "devnode" } } };`,
    );
    const configPath = path.join(projectDir, "lionden.config.ts");
    const originalArgv = process.argv;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.argv = ["node", "lionden", "--config", configPath, "--network", "ghostnet", "--help"];

      await expect(main()).resolves.toBeUndefined();
      expect(logSpy.mock.calls.flat().join("\n")).toContain("LionDen");
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  // Mirrors the index.ts boot order: the --network override must be taken from
  // the task-AWARE parse, after the LRE exists, not the earlier task-unaware one,
  // and an unknown network name is rejected centrally before dispatch.
  async function resolveNetworkOverrideThroughBoot(
    argv: string[],
    configContent: string,
  ): Promise<{ taskId: string | null; defaultNetwork: string }> {
    const deployPlugin: LionDenPlugin = {
      id: "deploy-test",
      name: "Deploy",
      tasks: [
        task("deploy", "Deploy")
          .setAction(async () => undefined)
          .build(),
      ],
    };

    const projectDir = createTempProject(configContent);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);
    const plugins = resolvePluginOrder([deployPlugin]);
    const globalOptionDefs = collectGlobalOptions(plugins);
    const { resolved } = await resolveConfig(rawConfig as LionDenUserConfig, plugins, projectRoot);

    const config = { ...resolved };
    const lre = createLre({ config, plugins, globalOptions: {} });
    const parsed = parseArgs(argv, globalOptionDefs, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );
    if (typeof parsed.globalArgs.network === "string") {
      const requestedNetwork = parsed.globalArgs.network;
      if (!config.networks[requestedNetwork]) {
        const available = Object.keys(config.networks).join(", ") || "(none)";
        throw new Error(
          `Network "${requestedNetwork}" (from --network) is not defined in config.networks. ` +
            `Available networks: ${available}`,
        );
      }
      (config as { defaultNetwork: string }).defaultNetwork = requestedNetwork;
    }
    return { taskId: parsed.taskId, defaultNetwork: config.defaultNetwork };
  }

  it("does not override defaultNetwork when --network has no value", async () => {
    const { taskId, defaultNetwork } = await resolveNetworkOverrideThroughBoot(
      ["deploy", "--network"],
      `export default { defaultNetwork: "local" };`,
    );

    expect(taskId).toBe("deploy");
    expect(defaultNetwork).toBe("local");
  });

  it("does not let a value-less --network before the task swallow the task token", async () => {
    // `lionden --network deploy`: the task-unaware parse would read network="deploy"
    // and clobber defaultNetwork. The task-aware boot order must identify `deploy`
    // as the task and leave defaultNetwork untouched.
    const { taskId, defaultNetwork } = await resolveNetworkOverrideThroughBoot(
      ["--network", "deploy"],
      `export default { defaultNetwork: "local" };`,
    );

    expect(taskId).toBe("deploy");
    expect(defaultNetwork).toBe("local");
  });

  it("still applies a real --network override placed before the task", async () => {
    const { taskId, defaultNetwork } = await resolveNetworkOverrideThroughBoot(
      ["--network", "testnet", "deploy"],
      `export default {
        defaultNetwork: "local",
        networks: {
          local: { type: "devnode" },
          testnet: { type: "http", endpoint: "https://api.explorer.provable.com/v1", network: "testnet" },
        },
      };`,
    );

    expect(taskId).toBe("deploy");
    expect(defaultNetwork).toBe("testnet");
  });

  it("rejects an unknown --network name centrally before dispatch", async () => {
    await expect(
      resolveNetworkOverrideThroughBoot(
        ["--network", "ghostnet", "deploy"],
        `export default { defaultNetwork: "local", networks: { local: { type: "devnode" } } };`,
      ),
    ).rejects.toThrow('Network "ghostnet" (from --network) is not defined in config.networks');
  });

  it("seeds the built-in --prove into lre.globalOptions even when placed after the test task", async () => {
    // `--prove` is now a framework built-in global, so it is routed to
    // globalArgs (not taskArgs) regardless of position, and seeded into
    // lre.globalOptions — the built-in wins over any task arg of the same name.
    const testPlugin: LionDenPlugin = {
      id: "@lionden/plugin-test",
      name: "Test",
      tasks: [
        task("test", "Test")
          .setAction(async () => undefined)
          .build(),
      ],
    };

    const projectDir = createTempProject(`export default {};`);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);
    const plugins = resolvePluginOrder([testPlugin]);
    const globalOptionDefs = collectGlobalOptions(plugins);
    const { resolved } = await resolveConfig(rawConfig as LionDenUserConfig, plugins, projectRoot);

    // Mirror index.ts: create the LRE (empty globalOptions held by reference),
    // parse WITH task metadata, then seed the built-in --prove via the `in` test.
    const globalOptions: Record<string, unknown> = {};
    const lre = createLre({ config: resolved, plugins, globalOptions });
    const parsed = parseArgs(["test", "--prove"], globalOptionDefs, (taskId) =>
      lre.tasks.getTaskDefinition(taskId),
    );
    if ("prove" in parsed.globalArgs) {
      globalOptions["prove"] = parsed.globalArgs.prove;
    }

    expect(parsed.taskArgs["prove"]).toBeUndefined();
    expect(parsed.globalArgs["prove"]).toBe(true);
    expect(lre.globalOptions["prove"]).toBe(true);
  });

  it("preserves an explicit --prove=false and leaves prove unset when absent", async () => {
    const deployPlugin: LionDenPlugin = {
      id: "@lionden/plugin-deploy",
      name: "Deploy",
      tasks: [
        task("deploy", "Deploy")
          .setAction(async () => undefined)
          .build(),
      ],
    };

    const projectDir = createTempProject(`export default {};`);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);
    const plugins = resolvePluginOrder([deployPlugin]);
    const globalOptionDefs = collectGlobalOptions(plugins);
    const { resolved } = await resolveConfig(rawConfig as LionDenUserConfig, plugins, projectRoot);

    const seedProve = (argv: string[]): Record<string, unknown> => {
      const globalOptions: Record<string, unknown> = {};
      const lre = createLre({ config: resolved, plugins, globalOptions });
      const parsed = parseArgs(argv, globalOptionDefs, (taskId) =>
        lre.tasks.getTaskDefinition(taskId),
      );
      // The `in` test (not truthiness) lands an explicit false instead of dropping it.
      if ("prove" in parsed.globalArgs) {
        globalOptions["prove"] = parsed.globalArgs.prove;
      }
      return globalOptions;
    };

    expect(seedProve(["deploy", "--prove=false"])).toEqual({ prove: false });
    expect(seedProve(["deploy", "--prove"])).toEqual({ prove: true });
    expect("prove" in seedProve(["deploy"])).toBe(false);
  });

  it("validateTaskGlobalOptionCollisions rejects a raw task arg that shadows --prove", async () => {
    // The TaskBuilder rejects a `prove` arg up front, but a raw TaskDefinition
    // (e.g. from config.tasks) bypasses the builder — the central collision
    // check must still reject it before dispatch.
    const rawProvePlugin: LionDenPlugin = {
      id: "raw-prove",
      name: "Raw Prove",
      tasks: [
        {
          id: "custom",
          description: "Custom",
          action: async () => undefined,
          flags: [{ name: "prove", description: "Prove" }],
        },
      ],
    };

    const projectDir = createTempProject(`export default {};`);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);
    const plugins = resolvePluginOrder([rawProvePlugin]);
    const { resolved } = await resolveConfig(rawConfig as LionDenUserConfig, plugins, projectRoot);
    const lre = createLre({ config: resolved, plugins });

    expect(() => validateTaskGlobalOptionCollisions(lre)).toThrow(
      'Task "custom" argument "prove" conflicts with global option "--prove"',
    );
  });
});
