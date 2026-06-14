/** Convert camelCase to kebab-case (e.g., "noCompile" -> "no-compile"). */
export function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

export function getPublicArgumentNames(name: string): string[] {
  return [...new Set([name, camelToKebab(name)])];
}

/**
 * Render an argument name as the flag a user types: single-character names are
 * short flags (`-h`), everything else is a long flag (`--config`).
 */
export function argumentFlagName(name: string): string {
  return name.length === 1 ? `-${name}` : `--${name}`;
}

export const BUILT_IN_GLOBAL_ARGUMENT_NAMES = ["config", "network", "verbose", "help", "version"];

const BUILT_IN_GLOBAL_ARGUMENT_ALIASES = new Map<string, readonly string[]>([
  ["help", ["h"]],
  ["version", ["v"]],
]);

export function getReservedBuiltInGlobalArgumentNames(): Set<string> {
  const names = new Set<string>();
  for (const name of BUILT_IN_GLOBAL_ARGUMENT_NAMES) {
    for (const publicName of getPublicArgumentNames(name)) {
      names.add(publicName);
    }
    for (const alias of BUILT_IN_GLOBAL_ARGUMENT_ALIASES.get(name) ?? []) {
      names.add(alias);
    }
  }
  return names;
}
