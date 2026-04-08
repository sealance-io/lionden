import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Deploy the token program to the active network.
 * Usage: lionden run scripts/deploy.ts
 */
export default async function (hre: LionDenRuntimeEnvironment) {
  console.log("Compiling token program...");
  await hre.tasks.run("compile");

  console.log("Deploying token.aleo...");
  const results = await hre.tasks.run("deploy", { program: "token" });
  const deployResult = (results as Array<{ programId: string; txId: string }>)[0]!;

  console.log(`Deployed ${deployResult.programId} — tx: ${deployResult.txId}`);

  // Mint some initial tokens to account-0
  const accounts = (await import("@lionden/testing")).DEVNODE_ACCOUNTS;
  const receiver = accounts[0]!.address;

  console.log(`Minting 10000 tokens to ${receiver}...`);
  const network = hre.network as any;
  const connection = network.getConnection();
  await connection.execute("token.aleo", "mint_public", [receiver, "10000u64"], {
    mode: "onchain",
  });

  console.log("Done!");
}
