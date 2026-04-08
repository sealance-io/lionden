/**
 * LRE factory for test files.
 *
 * Discovers the project config, resolves it through the full plugin
 * lifecycle, and constructs a cached LRE singleton. This allows test
 * files to call `setup()` without manually constructing an HRE — the
 * factory handles config discovery and LRE creation transparently.
 *
 * Config is discovered from `LIONDEN_PROJECT_ROOT` (set by the test
 * runner) or by walking up from cwd.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenUserConfig } from "@lionden/config";
import type {
  LionDenRuntimeEnvironment,
  LionDenPlugin,
  TaskDefinition,
} from "@lionden/core";
import { resolvePluginOrder, resolveConfig, createLre } from "@lionden/core";

let cachedLre: LionDenRuntimeEnvironment | null = null;
let cachedPromise: Promise<LionDenRuntimeEnvironment> | null = null;

const CONFIG_FILENAMES = [
  "lionden.config.ts",
  "lionden.config.js",
  "lionden.config.mjs",
];

function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Create or return the cached LRE for the current test process.
 *
 * Discovers config from `LIONDEN_PROJECT_ROOT` env var (set by the
 * test runner) or by walking up from cwd.
 */
export async function createTestLre(): Promise<LionDenRuntimeEnvironment> {
  if (cachedLre) return cachedLre;
  if (cachedPromise) return cachedPromise;

  cachedPromise = buildLre();
  try {
    cachedLre = await cachedPromise;
  } catch (err) {
    // Clear so the next call retries instead of returning a stale rejection.
    cachedPromise = null;
    throw err;
  }
  cachedPromise = null;
  return cachedLre;
}

async function buildLre(): Promise<LionDenRuntimeEnvironment> {
  const projectRoot =
    process.env["LIONDEN_PROJECT_ROOT"] ?? process.cwd();
  const configPath = findConfigFile(projectRoot);

  if (!configPath) {
    throw new Error(
      `No lionden.config.{ts,js,mjs} found starting from "${projectRoot}". ` +
        `Ensure the test is run from a LionDen project directory.`,
    );
  }

  const absolutePath = path.resolve(configPath);
  const root = path.dirname(absolutePath);

  // Import config file (tsx handles .ts transpilation)
  const configModule = (await import(absolutePath)) as {
    default: unknown;
  };
  let rawConfig = configModule.default;
  if (typeof rawConfig === "function") {
    rawConfig = await rawConfig();
  }
  const userConfig = rawConfig as LionDenUserConfig;

  // Resolve plugins and config through the full lifecycle
  const userPlugins = (userConfig.plugins ?? []) as LionDenPlugin[];
  const plugins = resolvePluginOrder(userPlugins);
  const { resolved, extendedUserConfig } = await resolveConfig(userConfig, plugins, root);

  // Create LRE — use post-extend config for tasks so plugin-injected tasks are included
  const configTasks = (extendedUserConfig.tasks ?? []) as TaskDefinition[];
  return createLre({ config: resolved, plugins, configTasks });
}

/**
 * Reset the cached LRE. For internal testing only.
 */
export function resetTestLre(): void {
  cachedLre = null;
  cachedPromise = null;
}
