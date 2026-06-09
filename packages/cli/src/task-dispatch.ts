import type {
  GlobalOptionDefinition,
  LionDenRuntimeEnvironment,
  TaskDefinition,
} from "@lionden/core";
import {
  ArgumentType,
  getPublicArgumentNames,
  getReservedBuiltInGlobalArgumentNames,
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
  const { taskId, taskIndex } = findTask(argv, pluginGlobalOptions, getTaskDefinition);
  const taskDefinition = taskId ? getTaskDefinition?.(taskId) : undefined;
  const globalDefinitions = buildGlobalArgumentLookup(pluginGlobalOptions);
  const taskDefinitions = taskDefinition
    ? buildTaskArgumentLookup(taskDefinition)
    : new Map<string, TaskArgumentLookupEntry>();

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (i === taskIndex) {
      i++;
      continue;
    }
    if (arg.startsWith("--") || arg.startsWith("-")) {
      const rawName = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
      const globalDefinition = globalDefinitions.get(rawName);
      const taskDefinition = taskDefinitions.get(rawName);

      if (taskDefinition && !globalDefinition?.builtIn) {
        if (taskDefinition.type === "boolean") {
          taskArgs[taskDefinition.name] = true;
        } else if (canConsumeNextAsValue(argv, i, taskIndex)) {
          taskArgs[taskDefinition.name] = argv[++i];
        }
      } else if (globalDefinition) {
        if (globalDefinition.type === ArgumentType.BOOLEAN) {
          globalArgs[globalDefinition.name] = true;
        } else if (canConsumeNextAsValue(argv, i, taskIndex)) {
          globalArgs[globalDefinition.name] = argv[++i];
        }
      } else if (canConsumeNextAsValue(argv, i, taskIndex)) {
        taskArgs[rawName] = argv[++i];
      } else {
        taskArgs[rawName] = true;
      }
    } else {
      if (taskIndex >= 0 && i > taskIndex) {
        const positionals = (taskArgs._positional as string[]) ?? [];
        positionals.push(arg);
        taskArgs._positional = positionals;
      }
    }
    i++;
  }

  return { taskId, taskArgs, globalArgs };
}

interface GlobalArgumentLookupEntry {
  readonly name: string;
  readonly type: ArgumentType;
  readonly builtIn?: boolean;
}

interface TaskArgumentLookupEntry {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
}

const BUILT_IN_GLOBAL_ARGUMENTS = [
  { name: "config", type: ArgumentType.FILE },
  { name: "network", type: ArgumentType.STRING },
  { name: "verbose", type: ArgumentType.BOOLEAN },
  { name: "help", type: ArgumentType.BOOLEAN, aliases: ["h"] },
  { name: "version", type: ArgumentType.BOOLEAN, aliases: ["v"] },
] satisfies readonly (GlobalArgumentLookupEntry & { aliases?: readonly string[] })[];

function buildGlobalArgumentLookup(
  pluginGlobalOptions?: Map<string, { pluginId: string; definition: GlobalOptionDefinition }>,
): Map<string, GlobalArgumentLookupEntry> {
  const lookup = new Map<string, GlobalArgumentLookupEntry>();
  for (const definition of BUILT_IN_GLOBAL_ARGUMENTS) {
    const entry = { name: definition.name, type: definition.type, builtIn: true };
    for (const publicName of getPublicArgumentNames(definition.name)) {
      lookup.set(publicName, entry);
    }
    for (const alias of definition.aliases ?? []) {
      lookup.set(alias, entry);
    }
  }
  for (const { definition } of pluginGlobalOptions?.values() ?? []) {
    const entry = { name: definition.name, type: definition.type };
    for (const publicName of getPublicArgumentNames(definition.name)) {
      lookup.set(publicName, entry);
    }
  }
  return lookup;
}

function buildTaskArgumentLookup(
  taskDefinition: TaskDefinition,
): Map<string, TaskArgumentLookupEntry> {
  const lookup = new Map<string, TaskArgumentLookupEntry>();
  for (const flag of taskDefinition.flags ?? []) {
    const entry = { name: flag.name, type: "boolean" as const };
    for (const publicName of getPublicArgumentNames(flag.name)) {
      lookup.set(publicName, entry);
    }
  }
  for (const option of taskDefinition.options ?? []) {
    const entry = { name: option.name, type: option.type };
    for (const publicName of getPublicArgumentNames(option.name)) {
      lookup.set(publicName, entry);
    }
  }
  return lookup;
}

interface TaskDiscoveryResult {
  readonly taskId: string | null;
  readonly taskIndex: number;
}

function findTask(
  argv: readonly string[],
  pluginGlobalOptions?: Map<string, { pluginId: string; definition: GlobalOptionDefinition }>,
  getTaskDefinition?: TaskDefinitionLookup,
): TaskDiscoveryResult {
  const globalDefinitions = buildGlobalArgumentLookup(pluginGlobalOptions);
  let firstUnclaimedToken: TaskDiscoveryResult | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--") || arg.startsWith("-")) {
      const rawName = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
      const globalDefinition = globalDefinitions.get(rawName);
      if (globalDefinition && globalDefinition.type !== ArgumentType.BOOLEAN) {
        if (canConsumeAsValue(argv[i + 1], getTaskDefinition)) {
          i++;
        }
      } else if (!globalDefinition && canConsumeAsValue(argv[i + 1], getTaskDefinition)) {
        i++;
      }
      continue;
    }
    if (getTaskDefinition?.(arg)) {
      return { taskId: arg, taskIndex: i };
    }
    firstUnclaimedToken ??= { taskId: arg, taskIndex: i };
  }
  return firstUnclaimedToken ?? { taskId: null, taskIndex: -1 };
}

function isOptionToken(token: string): boolean {
  return token.startsWith("-");
}

function canConsumeAsValue(
  token: string | undefined,
  getTaskDefinition?: TaskDefinitionLookup,
): boolean {
  if (token === undefined) return false;
  if (isOptionToken(token)) return false;
  if (getTaskDefinition?.(token)) return false;
  return true;
}

function canConsumeNextAsValue(argv: readonly string[], index: number, taskIndex: number): boolean {
  if (index + 1 === taskIndex) return false;
  return canConsumeAsValue(argv[index + 1]);
}

export function validateTaskGlobalOptionCollisions(lre: LionDenRuntimeEnvironment): void {
  const globalNames = getReservedBuiltInGlobalArgumentNames();

  for (const taskId of lre.tasks.getTaskIds()) {
    const taskDefinition = lre.tasks.getTaskDefinition(taskId);
    if (!taskDefinition) continue;
    for (const arg of [...(taskDefinition.options ?? []), ...(taskDefinition.flags ?? [])]) {
      for (const publicName of getPublicArgumentNames(arg.name)) {
        if (globalNames.has(publicName)) {
          throw new Error(
            `Task "${taskId}" argument "${arg.name}" conflicts with global option "--${publicName}"`,
          );
        }
      }
    }
  }
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
