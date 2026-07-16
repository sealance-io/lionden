import type { DeploymentRecipe } from "@lionden/plugin-deploy";
import { createTokenContract } from "../typechain/Token.js";

export interface TokenSetupResult {
  readonly programId: string;
  readonly treasury: string;
  readonly initialSupply: bigint;
}

const INITIAL_SUPPLY = 1_000_000n;

/**
 * Deploy token.aleo and mint initial supply to the treasury.
 *
 * Run from CLI:   lionden recipe --file recipes/setup.ts
 * Run from tests: await setupToken(ctx)  (TestContext satisfies DeploymentContext)
 *
 * Note: this recipe is intended for first-time deployment only. It passes
 * noSkipDeployed so re-running it fails instead of reusing an existing
 * token.aleo deployment and minting the initial supply again.
 */
export const setupToken: DeploymentRecipe<TokenSetupResult> = async (ctx) => {
  const { deployer, treasury } = ctx.named.require({
    deployer: "signer",
    treasury: "address",
  });

  const token = createTokenContract().connect(ctx.lre);
  await ctx.deploy(token, { noSkipDeployed: true });

  await token.withSigner(deployer).mint_public.accepted(treasury, INITIAL_SUPPLY);

  return { programId: token.programId, treasury: treasury.address, initialSupply: INITIAL_SUPPLY };
};

export default setupToken;
