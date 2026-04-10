import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Deploy the escrow program to the active network.
 * Usage: lionden run scripts/deploy.ts
 */
export default async function (lre: LionDenRuntimeEnvironment) {
  console.log("Compiling escrow program...");
  await lre.tasks.run("compile");

  console.log("Deploying escrow.aleo...");
  const results = await lre.tasks.run("deploy", { program: "escrow" });
  const deployResult = (results as Array<{ programId: string; txId: string }>)[0]!;

  console.log(`Deployed ${deployResult.programId} — tx: ${deployResult.txId}`);
}
