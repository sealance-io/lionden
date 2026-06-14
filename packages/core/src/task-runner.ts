import { argumentFlagName, getPublicArgumentNames } from "./arg-names.js";
import type {
  LionDenRuntimeEnvironment,
  TaskAction,
  TaskActionWithSuper,
  TaskDefinition,
  TaskRunner,
} from "./types.js";

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task "${taskId}" not found`);
    this.name = "TaskNotFoundError";
  }
}

interface RegisteredTask {
  definition: TaskDefinition;
  /** If this task was overridden, the chain of previous actions (most recent first) */
  overrideChain: TaskAction[];
}

/**
 * Manages task registration and execution with support for overrides
 */
export class TaskRunnerImpl implements TaskRunner {
  private readonly tasks = new Map<string, RegisteredTask>();
  private lre: LionDenRuntimeEnvironment | null = null;

  /** Bind the LRE (called once during LRE construction) */
  setLre(lre: LionDenRuntimeEnvironment): void {
    this.lre = lre;
  }

  /**
   * Register tasks from plugins (in load order) and config-level tasks.
   * Override tasks stack on top of existing ones.
   */
  registerTasks(definitions: readonly TaskDefinition[]): void {
    for (const def of definitions) {
      if (def.overrides) {
        // This is an override — stack on top
        const existing = this.tasks.get(def.overrides);
        if (!existing) {
          throw new Error(`Cannot override task "${def.overrides}": no such task registered`);
        }
        // Push the current action into the override chain
        existing.overrideChain.unshift(existing.definition.action as TaskAction);
        existing.definition = {
          ...existing.definition,
          action: def.action,
          description: def.description || existing.definition.description,
        };
      } else {
        // New task
        if (this.tasks.has(def.id)) {
          throw new Error(
            `Task "${def.id}" is already registered. Use overrideTask() to extend it.`,
          );
        }
        this.tasks.set(def.id, {
          definition: def,
          overrideChain: [],
        });
      }
    }
  }

  async run(taskId: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const registered = this.tasks.get(taskId);
    if (!registered) {
      throw new TaskNotFoundError(taskId);
    }

    if (!this.lre) {
      throw new Error("TaskRunner: LRE not initialized");
    }

    const action = registered.definition.action;

    const finalArgs = this.prepareArgs(registered.definition, args);

    // If there are overrides, create the runSuper chain
    if (registered.overrideChain.length > 0) {
      const runSuper = this.buildRunSuper(
        registered.overrideChain,
        0,
        this.lre,
        registered.definition,
      );
      // Override actions receive runSuper as third argument
      return (action as TaskActionWithSuper)(finalArgs, this.lre, runSuper);
    }

    return action(finalArgs, this.lre);
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  getTaskIds(): string[] {
    return [...this.tasks.keys()];
  }

  getTaskDefinition(taskId: string): TaskDefinition | undefined {
    return this.tasks.get(taskId)?.definition;
  }

  private buildRunSuper(
    chain: TaskAction[],
    index: number,
    lre: LionDenRuntimeEnvironment,
    definition: TaskDefinition,
  ): (args: Record<string, unknown>) => Promise<unknown> {
    return async (args: Record<string, unknown>) => {
      const action = chain[index]!;
      const preparedArgs = this.prepareArgs(definition, args);

      if (index + 1 < chain.length) {
        const nextSuper = this.buildRunSuper(chain, index + 1, lre, definition);
        return (action as TaskActionWithSuper)(preparedArgs, lre, nextSuper);
      }

      return action(preparedArgs, lre);
    };
  }

  /**
   * Prepare task args for an action: normalize CLI spellings (kebab-case →
   * camelCase, string → number coercion), fill default values for
   * options/flags, enforce required options, then bind positional arguments.
   *
   * Shared by {@link run} and the runSuper chain so override actions receive
   * the same fully-prepared args as the top-level action. The pipeline is
   * idempotent on already-prepared args: normalize maps canonical names to
   * themselves and only coerces strings, mergeDefaults only fills missing
   * names, enforcement only throws on a missing required option, and positional
   * binding only fills names not already present.
   */
  private prepareArgs(
    definition: TaskDefinition,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalized = this.normalizeArgs(definition, args);
    const merged = this.mergeDefaults(definition, normalized);
    this.enforceRequiredOptions(definition, merged);
    return this.applyPositionalArguments(definition, merged);
  }

  /**
   * Normalize CLI-parsed args to match the task definition's option, flag, and
   * positional names.
   *
   * The CLI parser stores raw flag names (e.g., "no-compile") and string values
   * (e.g., "5000" for --timeout 5000). This method:
   * 1. Maps kebab-case keys to their camelCase equivalents
   * 2. Coerces string values to the declared option type (number, boolean)
   *
   * Positionals are included so a positional supplied on the CLI by its public
   * name (e.g. `--script-path` for a `scriptPath` positional, which the parser
   * stores under the kebab key) is canonicalized to the name the action and the
   * required-positional check read — the validator already allow-lists these
   * public spellings, so without this they would pass validation but never bind.
   */
  private normalizeArgs(
    definition: TaskDefinition,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    // Build canonical name lookup: kebab-case → camelCase
    const canonicalMap = new Map<string, { name: string; type?: string }>();
    for (const opt of definition.options ?? []) {
      for (const publicName of getPublicArgumentNames(opt.name)) {
        canonicalMap.set(publicName, { name: opt.name, type: opt.type });
      }
    }
    for (const flag of definition.flags ?? []) {
      for (const publicName of getPublicArgumentNames(flag.name)) {
        canonicalMap.set(publicName, { name: flag.name, type: "boolean" });
      }
    }
    for (const positional of definition.positionalArguments ?? []) {
      for (const publicName of getPublicArgumentNames(positional.name)) {
        // A real option/flag spelling wins over a positional alias on a clash
        // (a config bug), so only fill names not already claimed above.
        if (!canonicalMap.has(publicName)) {
          canonicalMap.set(publicName, { name: positional.name });
        }
      }
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      const canonical = canonicalMap.get(key);
      if (canonical) {
        // Coerce string values to declared type
        if (typeof value === "string" && canonical.type === "number") {
          const num = Number(value);
          normalized[canonical.name] = Number.isNaN(num) ? value : num;
        } else {
          normalized[canonical.name] = value;
        }
      } else {
        // Pass through unrecognized args (e.g., _positional)
        normalized[key] = value;
      }
    }

    return normalized;
  }

  private mergeDefaults(
    definition: TaskDefinition,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged = { ...args };

    for (const opt of definition.options ?? []) {
      if (!(opt.name in merged) && opt.defaultValue !== undefined) {
        merged[opt.name] = opt.defaultValue;
      }
    }

    for (const flag of definition.flags ?? []) {
      if (!(flag.name in merged)) {
        merged[flag.name] = false;
      }
    }

    return merged;
  }

  /**
   * Enforce `required: true` on value options, mirroring the required-positional
   * check in {@link applyPositionalArguments}. Runs after defaults are merged, so
   * an option with both `required` and a `defaultValue` is satisfied by the
   * default. This covers every task dispatched through the runner (CLI and
   * programmatic `lre.tasks.run`); actions that are imported and invoked directly
   * keep their own guards for that separate entry point.
   */
  private enforceRequiredOptions(definition: TaskDefinition, args: Record<string, unknown>): void {
    for (const opt of definition.options ?? []) {
      if (opt.required && args[opt.name] === undefined) {
        throw new Error(
          `Task "${definition.id}" is missing required option "${argumentFlagName(opt.name)}".`,
        );
      }
    }
  }

  /**
   * Bind positional arguments to their declared names.
   *
   * The CLI parser stores raw positional values in `args._positional` (kept
   * populated for back-compat with hand-extraction in plugins). Bare values
   * fill the positionals not already supplied by name, left-to-right, so an
   * earlier named positional does not misalign the bare ones; a variadic
   * positional (declared last) collects every remaining bare value into an
   * array under its name. Finally it enforces `required` positionals — throwing
   * a clear error when a required positional was supplied neither by name nor
   * positionally.
   */
  private applyPositionalArguments(
    definition: TaskDefinition,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const positionalDefs = definition.positionalArguments;
    if (!positionalDefs || positionalDefs.length === 0) {
      return args;
    }

    const result = { ...args };
    const positionalValues = Array.isArray(result["_positional"])
      ? (result["_positional"] as unknown[])
      : [];

    // Bare values fill only the positionals NOT already supplied by name,
    // consumed left-to-right via a cursor. Advancing this cursor (rather than
    // indexing `_positional` by the declaration index) keeps the remaining bare
    // values aligned when an earlier positional was given by name — e.g. a named
    // `scriptPath` must not shift the bare args that fill a later positional.
    let cursor = 0;
    for (const def of positionalDefs) {
      // An explicitly-named value (a programmatic run({ script }) or a CLI
      // `--name` spelling canonicalized in normalizeArgs) wins over the bare
      // array and does not consume a bare slot. A variadic positional (always
      // declared last) takes every remaining bare value as an array, so an
      // action can read the whole tail by name instead of re-extracting from
      // `_positional`.
      if (!(def.name in result) && cursor < positionalValues.length) {
        result[def.name] = def.variadic ? positionalValues.slice(cursor) : positionalValues[cursor];
        cursor = def.variadic ? positionalValues.length : cursor + 1;
      }
      if (def.required && result[def.name] === undefined) {
        throw new Error(
          `Task "${definition.id}" is missing required positional argument "${def.name}".`,
        );
      }
    }

    return result;
  }
}
