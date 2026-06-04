import * as fs from "node:fs";
import * as path from "node:path";

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
  const module = (await import(absolutePath)) as {
    default: unknown;
  };

  let config = module.default;

  // Support factory functions
  if (typeof config === "function") {
    config = await config();
  }

  return { config, projectRoot };
}
