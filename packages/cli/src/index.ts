import * as path from "node:path";
import type { LionDenUserConfig } from "@lionden/config";
import {
  collectGlobalOptions,
  createLre,
  type LionDenPlugin,
  resolveConfig,
  resolvePluginOrder,
  type TaskDefinition,
} from "@lionden/core";
import { findConfigFile, loadConfigFile } from "./config-discovery.js";
import { logger } from "./output/logger.js";
import {
  dispatchTask,
  parseArgs,
  printHelp,
  validateTaskGlobalOptionCollisions,
} from "./task-dispatch.js";

const VERSION = "0.1.0";

export async function main(): Promise<void> {
  // Initial parse for early exits (--version, --help without config)
  let parsed = parseArgs(process.argv.slice(2));

  if (parsed.globalArgs.version) {
    console.log(`lionden v${VERSION}`);
    return;
  }

  if (parsed.globalArgs.verbose) {
    logger.setLevel("debug");
  }

  // Find and load config
  const configPath = parsed.globalArgs.config ?? findConfigFile(process.cwd());

  if (!configPath) {
    if (parsed.globalArgs.help) {
      printHelp();
      return;
    }
    logger.error(
      "No lionden.config.ts found. Run 'lionden init' to create a project, " +
        "or use --config to specify a config file.",
    );
    process.exit(1);
  }

  const absoluteConfigPath = path.resolve(configPath);
  logger.debug(`Loading config from ${absoluteConfigPath}`);
  const { config: rawConfig, projectRoot } = await loadConfigFile(absoluteConfigPath);
  const userConfig = rawConfig as LionDenUserConfig;

  // Resolve plugins
  const userPlugins = (userConfig.plugins ?? []) as LionDenPlugin[];
  const plugins = resolvePluginOrder(userPlugins);
  logger.debug(
    `Loaded ${plugins.length} plugins: ${plugins.map((p) => p.id).join(", ") || "(none)"}`,
  );

  // Collect plugin global options and re-parse with them
  const globalOptionDefs = collectGlobalOptions(plugins);
  parsed = parseArgs(process.argv.slice(2), globalOptionDefs);

  // Resolve config through the full lifecycle
  const { resolved: resolvedConfig, extendedUserConfig } = await resolveConfig(
    userConfig,
    plugins,
    projectRoot,
  );

  // Create LRE — use post-extend config for tasks (plugins may inject tasks via extendUserConfig).
  // Both `config` and `globalOptions` start as written here and are populated
  // AFTER the task-aware parse below; createLre stores them by reference, so the
  // network override and seeded global options flow through to lre.config /
  // lre.globalOptions without re-touching the LRE. (NetworkManagerImpl and
  // DeploymentManagerImpl capture lre.config by reference and read
  // defaultNetwork lazily, so mutating it here is observed at connect time.)
  const configTasks = (extendedUserConfig.tasks ?? []) as TaskDefinition[];
  const globalOptions: Record<string, unknown> = { configPath: absoluteConfigPath };
  const config = { ...resolvedConfig };
  const lre = createLre({ config, plugins, globalOptions, configTasks });

  // Re-parse WITH task metadata so named args are routed by schema rather than
  // by whether they appeared before or after the task name.
  parsed = parseArgs(process.argv.slice(2), globalOptionDefs, (taskId) =>
    lre.tasks.getTaskDefinition(taskId),
  );

  // Help should render before validating task/global option values. This keeps
  // recovery/documentation available even when an invocation includes an invalid
  // value such as `--network ghostnet --help`.
  if (parsed.globalArgs.help) {
    printHelp(lre, globalOptionDefs);
    return;
  }

  // Override default network from CLI. --network is global-only, and is resolved
  // from the task-aware parse — so a value-less `--network` before a task name
  // (e.g. `lionden --network deploy`) does not consume the task token as a bogus
  // network value the way the earlier task-unaware parse would. Validate the name
  // against config.networks here so an unknown --network fails once, centrally,
  // with a clear message — instead of later and differently inside each task's
  // connect path.
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
    // Seed the explicit --network into globalOptions so the test task can bridge it
    // to Vitest workers (LIONDEN_NETWORK). Other tasks keep reading config.defaultNetwork.
    globalOptions["network"] = requestedNetwork;
  }

  // Seed the built-in --prove preference into globalOptions so deploy/upgrade/
  // recipe/test resolve it via resolveProveOption()/lre.globalOptions. Unlike
  // --network this does NOT mutate config; the `in` check preserves an explicit
  // --prove=false (a falsy-but-present value) instead of treating it as unset.
  if ("prove" in parsed.globalArgs) {
    globalOptions["prove"] = parsed.globalArgs.prove;
  }

  // Seed global option values from the task-aware parse.
  for (const [name, { definition }] of globalOptionDefs) {
    if (name in parsed.globalArgs) {
      globalOptions[name] = (parsed.globalArgs as Record<string, unknown>)[name];
    } else if (definition.defaultValue !== undefined) {
      globalOptions[name] = definition.defaultValue;
    }
  }

  // Reject tasks whose arguments shadow a built-in global option before we
  // dispatch — otherwise the parser silently routes the colliding arg to the
  // global and the task never receives it.
  validateTaskGlobalOptionCollisions(lre);

  // Dispatch task
  await dispatchTask(lre, parsed);
}
