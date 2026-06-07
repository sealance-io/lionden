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
import { dispatchTask, parseArgs, printHelp } from "./task-dispatch.js";

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

  logger.debug(`Loading config from ${configPath}`);
  const { config: rawConfig, projectRoot } = await loadConfigFile(configPath);
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

  if (parsed.globalArgs.verbose) {
    logger.setLevel("debug");
  }

  // Resolve config through the full lifecycle
  const { resolved: resolvedConfig, extendedUserConfig } = await resolveConfig(
    userConfig,
    plugins,
    projectRoot,
  );

  // Override default network from CLI
  const networkOverride = parsed.globalArgs.network || (parsed.taskArgs.network as string);
  const config = networkOverride
    ? { ...resolvedConfig, defaultNetwork: networkOverride }
    : resolvedConfig;

  // Collect global option values for LRE
  const globalOptions: Record<string, unknown> = {};
  for (const [name, { definition }] of globalOptionDefs) {
    if (name in parsed.globalArgs) {
      globalOptions[name] = (parsed.globalArgs as Record<string, unknown>)[name];
    } else if (definition.defaultValue !== undefined) {
      globalOptions[name] = definition.defaultValue;
    }
  }

  // Create LRE — use post-extend config for tasks (plugins may inject tasks via extendUserConfig)
  const configTasks = (extendedUserConfig.tasks ?? []) as TaskDefinition[];
  const lre = createLre({ config, plugins, globalOptions, configTasks });
  parsed = parseArgs(process.argv.slice(2), globalOptionDefs, (taskId) =>
    lre.tasks.getTaskDefinition(taskId),
  );

  // Handle help
  if (parsed.globalArgs.help) {
    printHelp(lre, globalOptionDefs);
    return;
  }

  // Dispatch task
  await dispatchTask(lre, parsed);
}
