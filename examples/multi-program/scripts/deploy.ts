import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Deploy all programs in dependency order.
 * Usage: lionden run scripts/deploy.ts
 *
 * The deploy task discovers all programs under programs/, resolves their
 * dependencies via topological sort, and deploys them in the correct order.
 * Libraries (like math_utils) are compiled but not deployed.
 */
export default async function (lre: LionDenRuntimeEnvironment) {
  console.log("Compiling all programs...");
  await lre.tasks.run("compile");

  console.log("Deploying all programs in dependency order...");
  const results = await lre.tasks.run("deploy");
  const deployResults = results as Array<{
    programId: string;
    txId: string;
  }>;

  for (const result of deployResults) {
    console.log(`Deployed ${result.programId} — tx: ${result.txId}`);
  }

  console.log(`Done! Deployed ${deployResults.length} program(s).`);
}
