import { camelToKebab } from "./arg-names.js";
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

    // Normalize CLI args (kebab-case → camelCase, string → number coercion)
    // then fill default values for options/flags, then bind positional args.
    const normalizedArgs = this.normalizeArgs(registered.definition, args);
    const mergedArgs = this.mergeDefaults(registered.definition, normalizedArgs);
    const finalArgs = this.applyPositionalArguments(registered.definition, mergedArgs);

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
      const mergedArgs = this.mergeDefaults(definition, args);

      if (index + 1 < chain.length) {
        const nextSuper = this.buildRunSuper(chain, index + 1, lre, definition);
        return (action as TaskActionWithSuper)(mergedArgs, lre, nextSuper);
      }

      return action(mergedArgs, lre);
    };
  }

  /**
   * Normalize CLI-parsed args to match the task definition's option/flag names.
   *
   * The CLI parser stores raw flag names (e.g., "no-compile") and string values
   * (e.g., "5000" for --timeout 5000). This method:
   * 1. Maps kebab-case keys to their camelCase equivalents
   * 2. Coerces string values to the declared option type (number, boolean)
   */
  private normalizeArgs(
    definition: TaskDefinition,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    // Build canonical name lookup: kebab-case → camelCase
    const canonicalMap = new Map<string, { name: string; type?: string }>();
    for (const opt of definition.options ?? []) {
      canonicalMap.set(opt.name, { name: opt.name, type: opt.type });
      const kebab = camelToKebab(opt.name);
      if (kebab !== opt.name) {
        canonicalMap.set(kebab, { name: opt.name, type: opt.type });
      }
    }
    for (const flag of definition.flags ?? []) {
      canonicalMap.set(flag.name, { name: flag.name, type: "boolean" });
      const kebab = camelToKebab(flag.name);
      if (kebab !== flag.name) {
        canonicalMap.set(kebab, { name: flag.name, type: "boolean" });
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
   * Bind positional arguments to their declared names.
   *
   * The CLI parser stores raw positional values in `args._positional` (kept
   * populated for back-compat with hand-extraction in plugins). This maps each
   * `_positional[i]` onto `positionalArguments[i].name` so actions can read by
   * name, then enforces `required` positionals — throwing a clear error when a
   * required positional was supplied neither by name nor positionally.
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

    positionalDefs.forEach((def, i) => {
      // An explicitly-named value (e.g. from a programmatic run({ script }))
      // wins over the positional array; otherwise bind from _positional[i].
      if (!(def.name in result) && i < positionalValues.length) {
        result[def.name] = positionalValues[i];
      }
      if (def.required && result[def.name] === undefined) {
        throw new Error(
          `Task "${definition.id}" is missing required positional argument "${def.name}".`,
        );
      }
    });

    return result;
  }
}
