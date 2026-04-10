import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Deploy the NFT program to the active network.
 * Usage: lionden run scripts/deploy.ts
 */
export default async function (lre: LionDenRuntimeEnvironment) {
  console.log("Compiling nft_registry program...");
  await lre.tasks.run("compile");

  console.log("Deploying nft_registry.aleo...");
  const results = await lre.tasks.run("deploy", { program: "nft_registry" });
  const deployResult = (results as Array<{ programId: string; txId: string }>)[0]!;

  console.log(`Deployed ${deployResult.programId} — tx: ${deployResult.txId}`);
}
