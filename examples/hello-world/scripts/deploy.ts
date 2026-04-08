import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Deploy the hello program to the active network.
 * Usage: lionden run scripts/deploy.ts
 */
export default async function (lre: LionDenRuntimeEnvironment) {
  console.log("Compiling hello program...");
  await lre.tasks.run("compile");

  console.log("Deploying hello.aleo...");
  const results = await lre.tasks.run("deploy", { program: "hello" });
  const deployResult = (results as Array<{ programId: string; txId: string }>)[0]!;

  console.log(`Deployed ${deployResult.programId} — tx: ${deployResult.txId}`);
}
