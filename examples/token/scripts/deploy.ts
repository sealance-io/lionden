import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Deploy the token program and mint initial supply to the treasury.
 * Usage: lionden run scripts/deploy.ts
 *
 * Targets lre.config.defaultNetwork. For a different network use:
 *   lionden recipe --file recipes/setup.ts --network <name>
 */
export default async function (lre: LionDenRuntimeEnvironment) {
  await lre.tasks.run("recipe", { file: "recipes/setup.ts" });
}
