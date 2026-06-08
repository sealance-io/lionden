import type {
  GlobalOptionDefinition,
  LionDenRuntimeEnvironment,
  TaskDefinition,
} from "@lionden/core";
import { logger } from "./output/logger.js";

export type TaskDefinitionLookup = (taskId: string) => TaskDefinition | undefined;

export interface ParsedArgs {
  taskId: string | null;
  taskArgs: Record<string, unknown>;
  globalArgs: Record<string, unknown> & {
    config?: string;
    network?: string;
    verbose?: boolean;
    help?: boolean;
    version?: boolean;
  };
}

/**
 * Parse CLI arguments into structured form.
 * Format: lionden [global-options] <task> [task-options]
 *
 * @param pluginGlobalOptions - global options registered by plugins
 */
export function parseArgs(
  argv: string[],
  pluginGlobalOptions?: Map<string, { pluginId: string; definition: GlobalOptionDefinition }>,
  getTaskDefinition?: TaskDefinitionLookup,
): ParsedArgs {
  const globalArgs: ParsedArgs["globalArgs"] = {};
  const taskArgs: Record<string, unknown> = {};
  let taskId: string | null = null;
  let taskDefinition: TaskDefinition | undefined;
  let parsingGlobal = true;

  // Build set of known plugin global option names for matching
  const pluginOptionNames = new Set(pluginGlobalOptions?.keys() ?? []);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (parsingGlobal) {
      if (arg === "--config" && i + 1 < argv.length) {
        globalArgs.config = argv[++i];
      } else if (arg === "--network" && i + 1 < argv.length) {
        globalArgs.network = argv[++i];
      } else if (arg === "--verbose") {
        globalArgs.verbose = true;
      } else if (arg === "--help" || arg === "-h") {
        globalArgs.help = true;
      } else if (arg === "--version" || arg === "-v") {
        globalArgs.version = true;
      } else if (arg.startsWith("--") && pluginOptionNames.has(arg.slice(2))) {
        // Plugin global option
        const name = arg.slice(2);
        const def = pluginGlobalOptions!.get(name)!.definition;
        if (def.type === "BOOLEAN") {
          globalArgs[name] = true;
        } else if (i + 1 < argv.length) {
          globalArgs[name] = argv[++i];
        }
      } else if (!arg.startsWith("--")) {
        taskId = arg;
        taskDefinition = getTaskDefinition?.(taskId);
        parsingGlobal = false;
      }
    } else {
      // Task arguments
      if (arg.startsWith("--")) {
        const name = arg.slice(2);
        const taskArg = taskDefinition
          ? findTaskArgumentDefinition(taskDefinition, name)
          : undefined;
        const next = argv[i + 1];
        if (taskArg?.type === "boolean") {
          taskArgs[name] = true;
        } else if (
          taskArg === undefined &&
          pluginGlobalOptions?.get(name)?.definition.type === "BOOLEAN"
        ) {
          // A known boolean GLOBAL option placed after the task name. Record it
          // like its pre-task form (globalArgs → lre.globalOptions) rather than
          // letting the greedy fallback below swallow the following token as a
          // bogus string value. Task-defined args of the same name still win,
          // since `taskArg === undefined` gates this branch.
          globalArgs[name] = true;
        } else if (next && !next.startsWith("--")) {
          taskArgs[name] = next;
          i++;
        } else {
          taskArgs[name] = true;
        }
      } else {
        // Positional argument — store as _positional array
        const positionals = (taskArgs["_positional"] as string[]) ?? [];
        positionals.push(arg);
        taskArgs["_positional"] = positionals;
      }
    }
    i++;
  }

  return { taskId, taskArgs, globalArgs };
}

function findTaskArgumentDefinition(
  taskDefinition: TaskDefinition,
  rawName: string,
): { type: "string" | "number" | "boolean" } | undefined {
  for (const flag of taskDefinition.flags ?? []) {
    if (matchesTaskArgumentName(flag.name, rawName)) {
      return { type: "boolean" };
    }
  }

  for (const option of taskDefinition.options ?? []) {
    if (matchesTaskArgumentName(option.name, rawName)) {
      return { type: option.type };
    }
  }

  return undefined;
}

function matchesTaskArgumentName(definitionName: string, rawName: string): boolean {
  return rawName === definitionName || rawName === camelToKebab(definitionName);
}

/** Convert camelCase to kebab-case (e.g., "noCompile" -> "no-compile"). */
function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/**
 * Print help text for the CLI.
 */
export function printHelp(
  lre?: LionDenRuntimeEnvironment,
  pluginGlobalOptions?: Map<string, { pluginId: string; definition: GlobalOptionDefinition }>,
): void {
  console.log(`
\x1b[1mLionDen\x1b[0m — Aleo/Leo Development Framework

\x1b[1mUsage:\x1b[0m
  lionden [options] <task> [task-options]

\x1b[1mGlobal Options:\x1b[0m
  --config <path>     Path to config file (default: lionden.config.ts)
  --network <name>    Network to use (overrides config default)
  --verbose           Show debug output
  --help, -h          Show this help
  --version, -v       Show version`);

  if (pluginGlobalOptions && pluginGlobalOptions.size > 0) {
    console.log(`
\x1b[1mPlugin Options:\x1b[0m`);
    for (const [, { definition }] of pluginGlobalOptions) {
      const typeHint = definition.type === "BOOLEAN" ? "" : ` <${definition.type.toLowerCase()}>`;
      console.log(`  --${definition.name}${typeHint}    ${definition.description}`);
    }
  }

  if (lre) {
    const taskIds = lre.tasks.getTaskIds();
    if (taskIds.length > 0) {
      console.log(`
\x1b[1mAvailable Tasks:\x1b[0m`);
      for (const id of taskIds.sort()) {
        console.log(`  ${id}`);
      }
    }
  }

  console.log();
}

/**
 * Execute a task from parsed CLI arguments.
 */
export async function dispatchTask(
  lre: LionDenRuntimeEnvironment,
  parsed: ParsedArgs,
): Promise<void> {
  if (!parsed.taskId) {
    printHelp(lre);
    return;
  }

  if (!lre.tasks.has(parsed.taskId)) {
    logger.error(`Unknown task: "${parsed.taskId}"`);
    logger.info("Run 'lionden --help' to see available tasks.");
    process.exit(1);
  }

  await lre.tasks.run(parsed.taskId, parsed.taskArgs);
}
