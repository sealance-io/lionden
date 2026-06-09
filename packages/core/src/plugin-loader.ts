import { getPublicArgumentNames, getReservedBuiltInGlobalArgumentNames } from "./arg-names.js";
import type { GlobalOptionDefinition, LionDenPlugin } from "./types.js";

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLoadError";
  }
}

/**
 * Resolves plugin load order using topological sort.
 *
 * @param plugins - The user-provided plugin list
 * @returns Plugins in dependency-first order
 */
export function resolvePluginOrder(plugins: readonly LionDenPlugin[]): LionDenPlugin[] {
  const allPlugins = new Map<string, LionDenPlugin>();

  // Reverse once so LIFO pop() seeds the plugin map in declared order. Only the
  // relative order of independent roots depends on this — the DFS below already
  // places every dependency before its dependents regardless of insertion order.
  const toVisit = [...plugins].reverse();
  // Collect all plugins including transitive dependencies
  while (toVisit.length > 0) {
    const plugin = toVisit.pop()!;
    if (allPlugins.has(plugin.id)) {
      const existing = allPlugins.get(plugin.id)!;
      if (existing !== plugin) {
        throw new PluginLoadError(`Duplicate plugin ID "${plugin.id}" with different instances`);
      }
      continue;
    }
    allPlugins.set(plugin.id, plugin);

    // Hard dependencies must all be included
    for (const dep of plugin.dependencies ?? []) {
      toVisit.push(dep);
    }
  }

  // Topological sort via DFS
  const sorted: LionDenPlugin[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // cycle detection

  function visit(plugin: LionDenPlugin): void {
    if (visited.has(plugin.id)) return;
    if (visiting.has(plugin.id)) {
      throw new PluginLoadError(`Circular plugin dependency detected involving "${plugin.id}"`);
    }

    visiting.add(plugin.id);

    // Visit hard dependencies
    for (const dep of plugin.dependencies ?? []) {
      const resolved = allPlugins.get(dep.id);
      if (!resolved) {
        throw new PluginLoadError(
          `Plugin "${plugin.id}" depends on "${dep.id}" which is not available`,
        );
      }
      visit(resolved);
    }

    visiting.delete(plugin.id);
    visited.add(plugin.id);
    sorted.push(plugin);
  }

  for (const plugin of allPlugins.values()) {
    visit(plugin);
  }

  return sorted;
}

/**
 * Collect all global options from the resolved plugin list.
 * Validates there are no name collisions.
 */
export function collectGlobalOptions(
  plugins: readonly LionDenPlugin[],
): Map<string, { pluginId: string; definition: GlobalOptionDefinition }> {
  const options = new Map<string, { pluginId: string; definition: GlobalOptionDefinition }>();
  const reservedBuiltInNames = getReservedBuiltInGlobalArgumentNames();

  for (const plugin of plugins) {
    for (const opt of plugin.globalOptions ?? []) {
      for (const publicName of getPublicArgumentNames(opt.name)) {
        if (reservedBuiltInNames.has(publicName)) {
          throw new PluginLoadError(
            `Global option "--${opt.name}" registered by "${plugin.id}" conflicts with built-in global option "--${publicName}"`,
          );
        }
      }
      if (options.has(opt.name)) {
        const existing = options.get(opt.name)!;
        throw new PluginLoadError(
          `Global option "--${opt.name}" registered by both "${existing.pluginId}" and "${plugin.id}"`,
        );
      }
      options.set(opt.name, { pluginId: plugin.id, definition: opt });
    }
  }

  return options;
}
