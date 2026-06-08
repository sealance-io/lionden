import {
  ArgumentType,
  type TaskAction,
  type TaskActionWithSuper,
  type TaskDefinition,
  type TaskFlag,
  type TaskOption,
  type TaskPositionalArgument,
} from "./types.js";

export { ArgumentType };

/**
 * Fluent builder for creating task definitions.
 *
 * @example
 * ```ts
 * const compileTask = task("compile", "Compile Leo programs")
 *   .addOption({ name: "force", type: "boolean", defaultValue: false, description: "Force recompile" })
 *   .addFlag({ name: "noTypechain", description: "Skip TypeScript binding generation" })
 *   .setAction(async (args, lre) => { ... })
 *   .build();
 * ```
 */
export class TaskBuilder {
  private readonly _id: string;
  private readonly _description: string;
  private _action: TaskAction | null = null;
  private readonly _options: TaskOption[] = [];
  private readonly _flags: TaskFlag[] = [];
  private readonly _positionalArguments: TaskPositionalArgument[] = [];
  private readonly _argumentNames = new Map<
    string,
    { readonly kind: "option" | "flag" | "positional argument"; readonly name: string }
  >();

  constructor(id: string, description: string) {
    this._id = id;
    this._description = description;
  }

  addOption(option: TaskOption): this {
    this.registerArgumentName("option", option.name);
    this._options.push(option);
    return this;
  }

  addFlag(flag: TaskFlag): this {
    this.registerArgumentName("flag", flag.name);
    this._flags.push(flag);
    return this;
  }

  addPositionalArgument(arg: TaskPositionalArgument): this {
    this.registerArgumentName("positional argument", arg.name);
    this._positionalArguments.push(arg);
    return this;
  }

  /** Set an inline action function */
  setAction(action: TaskAction): this {
    this._action = action;
    return this;
  }

  /** Set a lazy-loaded action that will be resolved at dispatch time */
  setLazyAction(factory: () => Promise<{ default: TaskAction }>): this {
    const lazyFactory = factory as unknown as TaskAction & { _liondenLazy: true };
    lazyFactory._liondenLazy = true;
    this._action = lazyFactory;
    return this;
  }

  build(): TaskDefinition {
    if (!this._action) {
      throw new Error(`Task "${this._id}" has no action set`);
    }

    return {
      id: this._id,
      description: this._description,
      action: this._action,
      options: this._options.length > 0 ? [...this._options] : undefined,
      flags: this._flags.length > 0 ? [...this._flags] : undefined,
      positionalArguments:
        this._positionalArguments.length > 0 ? [...this._positionalArguments] : undefined,
    };
  }

  private registerArgumentName(
    kind: "option" | "flag" | "positional argument",
    name: string,
  ): void {
    for (const publicName of getPublicArgumentNames(name)) {
      const existing = this._argumentNames.get(publicName);
      if (existing) {
        throw new Error(
          `Task "${this._id}" ${kind} "${name}" conflicts with existing ${existing.kind} "${existing.name}"`,
        );
      }
      this._argumentNames.set(publicName, { kind, name });
    }

    for (const publicName of getPublicArgumentNames(name)) {
      this._argumentNames.set(publicName, { kind, name });
    }
  }
}

function getPublicArgumentNames(name: string): string[] {
  const names = new Set([name, camelToKebab(name)]);
  return [...names];
}

/** Convert camelCase to kebab-case (e.g., "noCompile" -> "no-compile"). */
function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/**
 * Builder for overriding an existing task. Cannot add/remove parameters.
 * The action receives `runSuper` as a third argument.
 */
export class OverrideTaskBuilder {
  private readonly _id: string;
  private _action: TaskActionWithSuper | null = null;

  constructor(id: string) {
    this._id = id;
  }

  setAction(action: TaskActionWithSuper): this {
    this._action = action;
    return this;
  }

  build(): TaskDefinition {
    if (!this._action) {
      throw new Error(`Override for task "${this._id}" has no action set`);
    }

    const capturedAction = this._action;
    return {
      id: this._id,
      description: "", // overrides inherit the original description
      overrides: this._id,
      action: capturedAction as unknown as TaskAction, // runSuper is injected at dispatch time
    };
  }
}

/** Create a new task definition */
export function task(id: string, description: string): TaskBuilder {
  return new TaskBuilder(id, description);
}

/** Create a task override */
export function overrideTask(id: string): OverrideTaskBuilder {
  return new OverrideTaskBuilder(id);
}
