import type { DeploymentRecipe } from "@lionden/plugin-deploy";

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
 * Note: this recipe is intended for first-time deployment only. Re-running it
 * on a network where token.aleo is already deployed will fail because the
 * deploy step returns no results when skipDeployed skips all targets and
 * DeploymentContext.deploy() does not accept a noSkipDeployed override.
 */
export const setupToken: DeploymentRecipe<TokenSetupResult> = async (ctx) => {
  const { deployer, treasury } = ctx.named.require({
    deployer: "signer",
    treasury: "address",
  });

  const { programId } = await ctx.deploy("token");

  await ctx.execute(
    "token.aleo",
    "mint_public",
    [treasury.address, `${INITIAL_SUPPLY}u64`],
    { signer: deployer },
  );

  return { programId, treasury: treasury.address, initialSupply: INITIAL_SUPPLY };
};

export default setupToken;
