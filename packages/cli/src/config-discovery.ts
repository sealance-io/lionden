import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_FILENAMES = ["lionden.config.ts", "lionden.config.js", "lionden.config.mjs"];

/**
 * Find the nearest lionden config file by walking up from the given directory.
 * Returns the absolute path to the config file, or null if not found.
 */
export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

/**
 * Load and return the user config from a config file.
 * Uses dynamic import() which handles both .ts (via tsx loader) and .js/.mjs.
 */
export async function loadConfigFile(
  configPath: string,
): Promise<{ config: unknown; projectRoot: string }> {
  const absolutePath = path.resolve(configPath);
  const projectRoot = path.dirname(absolutePath);

  // Dynamic import — tsx handles .ts transpilation
  const module = (await import(configPathToImportSpecifier(absolutePath))) as {
    default: unknown;
  };

  let config = module.default;

  // A config file that loads cleanly but has no default export yields
  // `module.default === undefined`. Fail here, naming the offending file,
  // instead of letting `undefined` leak downstream and surface as a cryptic
  // `Cannot read properties of undefined (reading 'plugins')` TypeError.
  if (config === undefined) {
    throw new Error(
      `Config file ${absolutePath} has no default export. ` +
        "Add `export default defineConfig({ ... })` (or a config object/factory).",
    );
  }

  // Support factory functions
  if (typeof config === "function") {
    config = await config();
    if (config === undefined) {
      throw new Error(
        `Config file ${absolutePath} default export returned undefined. ` +
          "Return `defineConfig({ ... })` (or a config object).",
      );
    }
  }

  return { config, projectRoot };
}

// Internal helper exported for testing
export function configPathToImportSpecifier(configPath: string): string {
  return pathToFileURL(path.resolve(configPath)).href;
}
