import type {
  TaskDefinition,
  TaskAction,
  TaskActionWithSuper,
  TaskRunner,
  LionDenRuntimeEnvironment,
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
 * and dependency tasks.
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
          throw new Error(
            `Cannot override task "${def.overrides}": no such task registered`,
          );
        }
        // Push the current action into the override chain
        existing.overrideChain.unshift(
          existing.definition.action as TaskAction,
        );
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

  async run(
    taskId: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const registered = this.tasks.get(taskId);
    if (!registered) {
      throw new TaskNotFoundError(taskId);
    }

    if (!this.lre) {
      throw new Error("TaskRunner: LRE not initialized");
    }

    // Run dependency tasks first
    for (const depId of registered.definition.dependencies ?? []) {
      await this.run(depId);
    }

    // Resolve the action (may be lazy-loaded)
    const action = await this.resolveAction(registered.definition.action);

    // Fill default values for options
    const mergedArgs = this.mergeDefaults(registered.definition, args);

    // If there are overrides, create the runSuper chain
    if (registered.overrideChain.length > 0) {
      const runSuper = this.buildRunSuper(
        registered.overrideChain,
        0,
        this.lre,
        registered.definition,
      );
      // Override actions receive runSuper as third argument
      return (action as TaskActionWithSuper)(mergedArgs, this.lre, runSuper);
    }

    return action(mergedArgs, this.lre);
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

  private async resolveAction(
    action: TaskDefinition["action"],
  ): Promise<TaskAction> {
    // Lazy-loaded actions are marked by being a LazyAction wrapper.
    // We detect them by checking if they have a _lionden_lazy property,
    // or if they return a module with a default export.
    // For safety, we only treat it as a factory if it was created via
    // the task builder's lazy import pattern (returns { default: fn }).
    if (typeof action === "function" && "_liondenLazy" in action) {
      const module = await (action as () => Promise<{ default: TaskAction }>)();
      return module.default;
    }
    return action as TaskAction;
  }

  private buildRunSuper(
    chain: TaskAction[],
    index: number,
    lre: LionDenRuntimeEnvironment,
    definition: TaskDefinition,
  ): (args: Record<string, unknown>) => Promise<unknown> {
    return async (args: Record<string, unknown>) => {
      const action = await this.resolveAction(chain[index]!);
      const mergedArgs = this.mergeDefaults(definition, args);

      if (index + 1 < chain.length) {
        const nextSuper = this.buildRunSuper(
          chain,
          index + 1,
          lre,
          definition,
        );
        return (action as TaskActionWithSuper)(mergedArgs, lre, nextSuper);
      }

      return action(mergedArgs, lre);
    };
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
}
