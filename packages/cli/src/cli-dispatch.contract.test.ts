/**
 * Tier 2 contract test — crosses: @lionden/cli + @lionden/core + @lionden/config
 *
 * Tests the CLI boot path end-to-end: config discovery → config loading from
 * disk → plugin resolution → config resolution → LRE creation → task dispatch.
 * Uses real loadConfigFile() against temp .ts config files on disk.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { findConfigFile, loadConfigFile } from "./config-discovery.js";
import { parseArgs, dispatchTask } from "./task-dispatch.js";
import {
  resolvePluginOrder,
  collectGlobalOptions,
  resolveConfig,
  createLre,
  task,
  ArgumentType,
  type LionDenPlugin,
  type TaskDefinition,
} from "@lionden/core";
import type { LionDenUserConfig } from "@lionden/config";
import { TempProjectBuilder, type TempProject } from "@lionden/test-internals";

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
    const projectDir = createTempProject(
      `export default { leoVersion: "4.0.0" };`,
    );

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

    const projectDir = createTempProject(
      `export default { leoVersion: "4.0.0" };`,
    );
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

    const { resolved } = await resolveConfig(
      rawConfig as LionDenUserConfig,
      plugins,
      projectRoot,
    );
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
      globalOptions: [
        { name: "prove", description: "Enable proofs", type: ArgumentType.BOOLEAN },
      ],
      tasks: [],
    };

    const projectDir = createTempProject(`export default {};`);
    const configPath = findConfigFile(projectDir)!;
    const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);

    const plugins = resolvePluginOrder([testPlugin]);
    const globalOptionDefs = collectGlobalOptions(plugins);

    const parsed = parseArgs(["--prove"], globalOptionDefs);
    expect(parsed.globalArgs["prove"]).toBe(true);

    const { resolved } = await resolveConfig(
      rawConfig as LionDenUserConfig,
      plugins,
      projectRoot,
    );
    const globalOptions: Record<string, unknown> = {};
    for (const [name] of globalOptionDefs) {
      if (name in parsed.globalArgs) {
        globalOptions[name] = (parsed.globalArgs as Record<string, unknown>)[name];
      }
    }

    const lre = createLre({ config: resolved, plugins, globalOptions });
    expect(lre.globalOptions["prove"]).toBe(true);
  });
});
