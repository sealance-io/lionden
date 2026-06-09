import { getPublicArgumentNames, getReservedBuiltInGlobalArgumentNames } from "./arg-names.js";
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
 *   .addFlag({ name: "force", description: "Force recompile" })
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
  private readonly _reservedBuiltInGlobalNames = getReservedBuiltInGlobalArgumentNames();

  constructor(id: string, description: string) {
    this._id = id;
    this._description = description;
  }

  addOption(option: TaskOption): this {
    if ((option as { type?: unknown }).type === "boolean") {
      throw new Error(
        `Task "${this._id}" option "${option.name}" uses boolean type. Boolean task arguments must be registered with addFlag().`,
      );
    }
    this.validateReservedBuiltInGlobalName("option", option.name);
    this.registerArgumentName("option", option.name);
    this._options.push(option);
    return this;
  }

  addFlag(flag: TaskFlag): this {
    this.validateReservedBuiltInGlobalName("flag", flag.name);
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
    // Validate all aliases before committing any, so a conflict on a later
    // alias never leaves an earlier alias half-registered.
    for (const publicName of getPublicArgumentNames(name)) {
      const existing = this._argumentNames.get(publicName);
      if (existing) {
        throw new Error(
          `Task "${this._id}" ${kind} "${name}" conflicts with existing ${existing.kind} "${existing.name}"`,
        );
      }
    }

    for (const publicName of getPublicArgumentNames(name)) {
      this._argumentNames.set(publicName, { kind, name });
    }
  }

  private validateReservedBuiltInGlobalName(kind: "option" | "flag", name: string): void {
    for (const publicName of getPublicArgumentNames(name)) {
      if (this._reservedBuiltInGlobalNames.has(publicName)) {
        throw new Error(
          `Task "${this._id}" ${kind} "${name}" conflicts with built-in global option "--${publicName}"`,
        );
      }
    }
  }
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
