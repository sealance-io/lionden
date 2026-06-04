import type { LionDenUserConfig } from "./types.js";

/**
 * Type-safe config helper. Provides autocomplete and validation
 * in lionden.config.ts. Returns the config object unchanged — no magic.
 *
 * Supports both static objects and async factory functions.
 *
 * @example
 * ```ts
 * import { defineConfig } from "@lionden/config";
 *
 * export default defineConfig({
 *   defaultNetwork: "devnode",
 *   networks: {
 *     devnode: { type: "devnode", autoBlock: true },
 *   },
 * });
 * ```
 */
export function defineConfig(config: LionDenUserConfig): LionDenUserConfig;
export function defineConfig(
  factory: () => LionDenUserConfig | Promise<LionDenUserConfig>,
): () => LionDenUserConfig | Promise<LionDenUserConfig>;
export function defineConfig(
  configOrFactory: LionDenUserConfig | (() => LionDenUserConfig | Promise<LionDenUserConfig>),
): LionDenUserConfig | (() => LionDenUserConfig | Promise<LionDenUserConfig>) {
  return configOrFactory;
}
