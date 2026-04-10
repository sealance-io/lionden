import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Deploy the counter program to the active network.
 * Usage: lionden run scripts/deploy.ts
 */
export default async function (lre: LionDenRuntimeEnvironment) {
  console.log("Compiling counter program...");
  await lre.tasks.run("compile");

  console.log("Deploying counter.aleo...");
  const results = await lre.tasks.run("deploy", { program: "counter" });
  const deployResult = (results as Array<{ programId: string; txId: string }>)[0]!;

  console.log(`Deployed ${deployResult.programId} — tx: ${deployResult.txId}`);
}
