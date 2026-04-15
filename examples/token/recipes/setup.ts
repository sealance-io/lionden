import type { DeploymentRecipe } from "@lionden/plugin-deploy";
import { isSignable } from "@lionden/config";

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
  // Validate named accounts before deploying so misconfiguration fails fast.
  const deployer = ctx.namedAccounts["deployer"];
  const treasury = ctx.namedAccounts["treasury"];

  if (!deployer || !isSignable(deployer)) {
    throw new Error(`"deployer" must be a signable named account`);
  }
  if (!treasury) {
    throw new Error(`"treasury" named account is not configured`);
  }

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
