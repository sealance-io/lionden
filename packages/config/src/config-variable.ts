/**
 * A placeholder for an environment variable or secret that will be resolved
 * at runtime during config resolution. Prevents secrets from appearing in
 * config source code.
 *
 * @example
 * ```ts
 * import { configVariable } from "@lionden/config";
 * privateKey: configVariable("ALEO_PRIVATE_KEY")
 * privateKey: configVariable("ALEO_PRIVATE_KEY", "APrivateKey1zkp...")
 * ```
 */
export interface ConfigVariable {
  readonly _type: "ConfigVariable";
  readonly name: string;
  readonly defaultValue?: string;
}

export function configVariable(name: string, defaultValue?: string): ConfigVariable {
  return { _type: "ConfigVariable", name, defaultValue };
}

export function isConfigVariable(value: unknown): value is ConfigVariable {
  return (
    typeof value === "object" &&
    value !== null &&
    "_type" in value &&
    (value as ConfigVariable)._type === "ConfigVariable"
  );
}

/**
 * Resolve a ConfigVariable to its string value using environment variables.
 * Throws if the variable is not set and no default is provided.
 */
export function resolveConfigVariable(variable: ConfigVariable): string {
  const value = process.env[variable.name] ?? variable.defaultValue;
  if (value === undefined) {
    throw new Error(
      `Configuration variable "${variable.name}" is not set and has no default value. ` +
        `Set the ${variable.name} environment variable or provide a default.`,
    );
  }
  return value;
}
