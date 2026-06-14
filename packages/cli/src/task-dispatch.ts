import type {
  GlobalOptionDefinition,
  LionDenRuntimeEnvironment,
  TaskDefinition,
} from "@lionden/core";
import {
  ArgumentType,
  argumentFlagName,
  getPublicArgumentNames,
  getReservedBuiltInGlobalArgumentNames,
} from "@lionden/core";
import { logger } from "./output/logger.js";

export type TaskDefinitionLookup = (taskId: string) => TaskDefinition | undefined;

export interface ParsedArgs {
  taskId: string | null;
  taskArgs: Record<string, unknown>;
  preTaskArgs: string[];
  globalArgs: Record<string, unknown> & {
    config?: string;
    network?: string;
    prove?: boolean;
    verbose?: boolean;
    help?: boolean;
    version?: boolean;
  };
}

/**
 * Parse CLI arguments into structured form.
 * Format: lionden [options] <task> [options]
 *
 * The task id is discovered by position (first token that names a registered
 * task), but named arguments are routed by public-name lookup against the
 * built-in globals, plugin globals, and the selected task's schema — so an
 * option is classified the same whether it appears before or after the task id.
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
  const preTaskArgs: string[] = [];
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
      const { rawName, inlineValue } = splitOptionToken(arg);
      const globalDefinition = globalDefinitions.get(rawName);
      const taskArg = taskDefinitions.get(rawName);

      // An inline `--opt=value` carries its own value, so it never consumes the
      // following token. Valued options without `=` fall back to the next token.
      if (taskArg && !globalDefinition?.builtIn) {
        if (taskArg.type === "boolean") {
          taskArgs[taskArg.name] = coerceFlagValue(inlineValue);
        } else if (inlineValue !== undefined) {
          taskArgs[taskArg.name] = inlineValue;
        } else if (canConsumeNextAsValue(argv, i, taskIndex)) {
          taskArgs[taskArg.name] = argv[++i];
        }
      } else if (globalDefinition) {
        if (globalDefinition.type === ArgumentType.BOOLEAN) {
          globalArgs[globalDefinition.name] = coerceFlagValue(inlineValue);
        } else if (inlineValue !== undefined) {
          globalArgs[globalDefinition.name] = inlineValue;
        } else if (canConsumeNextAsValue(argv, i, taskIndex)) {
          globalArgs[globalDefinition.name] = argv[++i];
        }
      } else if (inlineValue !== undefined) {
        taskArgs[rawName] = inlineValue;
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
      } else if (taskIndex >= 0 && i < taskIndex) {
        preTaskArgs.push(arg);
      }
    }
    i++;
  }

  return { taskId, taskArgs, preTaskArgs, globalArgs };
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
  { name: "prove", type: ArgumentType.BOOLEAN },
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
      const { rawName, inlineValue } = splitOptionToken(arg);
      const globalDefinition = globalDefinitions.get(rawName);
      const isValuedOption = !globalDefinition || globalDefinition.type !== ArgumentType.BOOLEAN;
      // A valued option consumes the following token as its value — unless it
      // already carries an inline `--opt=value`, in which case the next token is
      // untouched. A token that names a registered task is normally left alone
      // (so `lionden --network deploy` runs deploy with a value-less --network) —
      // but only when it is the last task candidate. If a *later* task token
      // exists to serve as the task, the immediate token is a genuine option
      // value even when it matches a task name, so `lionden --network test deploy`
      // (a network named "test") sets network=test and still dispatches deploy.
      if (
        inlineValue === undefined &&
        isValuedOption &&
        canConsumeAsValue(
          argv[i + 1],
          getTaskDefinition,
          hasTaskTokenAfter(argv, i + 1, getTaskDefinition),
        )
      ) {
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

/**
 * Split an option token into its name and optional inline value, supporting the
 * `--opt=value` / `-o=value` idiom. Without an `=`, `inlineValue` is undefined
 * and the option follows the usual "consume the next token" rules. Splitting on
 * the FIRST `=` keeps values that themselves contain `=` intact (e.g.
 * `--out=a=b` ⇒ name "out", value "a=b").
 */
function splitOptionToken(arg: string): { rawName: string; inlineValue: string | undefined } {
  const body = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
  const eq = body.indexOf("=");
  if (eq === -1) return { rawName: body, inlineValue: undefined };
  return { rawName: body.slice(0, eq), inlineValue: body.slice(eq + 1) };
}

/**
 * Resolve a boolean flag's value. Presence (no inline value) ⇒ `true`; an
 * explicit `=false` (case-insensitive) ⇒ `false`; any other inline value ⇒
 * `true`. This keeps boolean flags permissive (the parser never throws) while
 * making `--flag=false` mean what it says instead of being silently dropped.
 */
function coerceFlagValue(inlineValue: string | undefined): boolean {
  return inlineValue === undefined || inlineValue.toLowerCase() !== "false";
}

function canConsumeAsValue(
  token: string | undefined,
  getTaskDefinition?: TaskDefinitionLookup,
  allowTaskIdValue = false,
): boolean {
  if (token === undefined) return false;
  if (isOptionToken(token)) return false;
  if (!allowTaskIdValue && getTaskDefinition?.(token)) return false;
  return true;
}

/**
 * Does a token that names a registered task appear at any index after
 * `fromIndex`? Used to decide whether a valued option may consume a task-named
 * token as its value: it may, as long as another task token remains to be the
 * task.
 */
function hasTaskTokenAfter(
  argv: readonly string[],
  fromIndex: number,
  getTaskDefinition?: TaskDefinitionLookup,
): boolean {
  for (let j = fromIndex + 1; j < argv.length; j++) {
    const token = argv[j]!;
    if (!isOptionToken(token) && getTaskDefinition?.(token)) {
      return true;
    }
  }
  return false;
}

function canConsumeNextAsValue(argv: readonly string[], index: number, taskIndex: number): boolean {
  if (index + 1 === taskIndex) return false;
  return canConsumeAsValue(argv[index + 1]);
}

export function validateTaskGlobalOptionCollisions(lre: LionDenRuntimeEnvironment): void {
  const globalNames = getReservedBuiltInGlobalArgumentNames();
  for (const plugin of lre.plugins) {
    for (const opt of plugin.globalOptions ?? []) {
      for (const publicName of getPublicArgumentNames(opt.name)) {
        globalNames.add(publicName);
      }
    }
  }

  for (const taskId of lre.tasks.getTaskIds()) {
    const taskDefinition = lre.tasks.getTaskDefinition(taskId);
    if (!taskDefinition) continue;
    for (const arg of [...(taskDefinition.options ?? []), ...(taskDefinition.flags ?? [])]) {
      for (const publicName of getPublicArgumentNames(arg.name)) {
        if (globalNames.has(publicName)) {
          throw new Error(
            `Task "${taskId}" argument "${arg.name}" conflicts with global option "${argumentFlagName(publicName)}"`,
          );
        }
      }
    }
  }
}

export function validateParsedArgs(lre: LionDenRuntimeEnvironment, parsed: ParsedArgs): void {
  if (!parsed.taskId) {
    validateNoTaskArgs(parsed);
    return;
  }

  const taskDefinition = lre.tasks.getTaskDefinition(parsed.taskId);
  if (!taskDefinition) {
    throw new Error(`Unknown task: "${parsed.taskId}"`);
  }

  if (parsed.preTaskArgs.length > 0) {
    throw new Error(
      `Unexpected argument "${parsed.preTaskArgs[0]}" before task "${parsed.taskId}"`,
    );
  }

  const positionalValues = Array.isArray(parsed.taskArgs._positional)
    ? (parsed.taskArgs._positional as string[])
    : [];
  const positionalDefinitions = taskDefinition.positionalArguments ?? [];
  const variadic =
    positionalDefinitions.length > 0 &&
    positionalDefinitions[positionalDefinitions.length - 1]?.variadic === true;
  if (
    positionalValues.length > 0 &&
    !variadic &&
    positionalValues.length > positionalDefinitions.length
  ) {
    const unexpected = positionalValues[positionalDefinitions.length] ?? positionalValues[0];
    throw new Error(`Unexpected argument "${unexpected}" for task "${parsed.taskId}"`);
  }

  const allowedTaskArgs = buildTaskArgumentLookup(taskDefinition);
  for (const positional of taskDefinition.positionalArguments ?? []) {
    for (const publicName of getPublicArgumentNames(positional.name)) {
      allowedTaskArgs.set(publicName, { name: positional.name, type: "string" });
    }
  }

  for (const key of Object.keys(parsed.taskArgs)) {
    if (key === "_positional") continue;
    if (!allowedTaskArgs.has(key)) {
      throw new Error(`Unknown argument "${argumentFlagName(key)}" for task "${parsed.taskId}"`);
    }
  }
}

function validateNoTaskArgs(parsed: ParsedArgs): void {
  for (const key of Object.keys(parsed.taskArgs)) {
    if (key === "_positional") continue;
    throw new Error(`Unknown argument "${argumentFlagName(key)}"`);
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
  --prove             Force standard/proven builders on devnode (slower; --prove=false to disable)
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
