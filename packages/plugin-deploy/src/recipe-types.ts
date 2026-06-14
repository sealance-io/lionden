/**
 * Deployment recipe types.
 *
 * A deployment recipe is a reusable async function that deploys programs
 * and executes setup transactions. The same recipe can run from tests
 * (via TestContext, which structurally satisfies DeploymentContext) or
 * from the CLI (via `lionden recipe --file ./path.ts`).
 */

import type { NamedAccountAccessor, NamedAccounts } from "@lionden/config";
import type { LionDenRuntimeEnvironment, ProgramDeploymentTarget } from "@lionden/core";
import type {
  DevnodeAccount,
  NetworkConnection,
  RawTransitionOutput,
  Signer,
} from "@lionden/network";

export type { ProgramDeploymentTarget };

// ---------------------------------------------------------------------------
// DeploymentContext — the interface recipes receive
// ---------------------------------------------------------------------------

export interface DeploymentContext {
  /** Deploy a program by name or generated wrapper. Deploys transitive deps first. */
  deploy(
    program: ProgramDeploymentTarget,
    options?: RecipeDeployOptions,
  ): Promise<RecipeDeployResult>;
  /** Execute a transition on a deployed program. */
  execute(
    programId: string,
    transitionName: string,
    args: string[],
    options?: RecipeExecuteOptions,
  ): Promise<RecipeExecuteResult>;
  /** Pre-funded devnode accounts (empty on non-devnode networks). */
  readonly accounts: readonly DevnodeAccount[];
  /** Active network connection. */
  readonly connection: NetworkConnection;
  /** Full LRE for advanced use cases. */
  readonly lre: LionDenRuntimeEnvironment;
  /** The network name this context is connected to. */
  readonly network: string;
  /**
   * Resolved named accounts for the active network.
   * Empty object ({}) when no namedAccounts are configured in the project.
   */
  readonly namedAccounts: NamedAccounts;
  /** Domain-native accessor for required named account roles. */
  readonly named: NamedAccountAccessor;
}

export interface RecipeDeployOptions {
  priorityFee?: number;
  noCompile?: boolean;
  /** Fail instead of reusing or skipping already-deployed programs. */
  noSkipDeployed?: boolean;
  /**
   * Override proof generation for this deploy. When omitted, the deploy task
   * self-resolves the run-level preference (`--prove` / `LIONDEN_PROVE`); set
   * it (e.g. `{ prove: false }`) to skip proving one fixture deploy while the
   * rest of the recipe proves.
   */
  prove?: boolean;
}

export interface RecipeDeployResult {
  readonly programId: string;
  readonly txId: string;
}

export interface RecipeExecuteOptions {
  mode?: "local" | "onchain";
  fee?: number;
  /**
   * Override proof generation for this execution. Defaults to the recipe's
   * run-level prove preference (`--prove` / `LIONDEN_PROVE`); a per-call value
   * beats it.
   */
  prove?: boolean;
  signer?: Signer;
  /**
   * On-chain mode only. When omitted or `true`, the call awaits confirmation
   * and returns the matching transition's parsed outputs. When `false`, the
   * call returns immediately after broadcast with `outputs: []`; callers can
   * fetch outputs later via `connection.getTransitionOutputs(...)`.
   */
  awaitConfirmation?: boolean;
}

export interface RecipeExecuteResult {
  readonly outputs: string[];
  /**
   * Faithful on-chain output shape including the `idOnly` discriminator for
   * dynamic-record outputs. Present only when the call awaited confirmation.
   */
  readonly rawOutputs?: readonly RawTransitionOutput[];
  readonly txId?: string;
}

// ---------------------------------------------------------------------------
// DeploymentRecipe — the function type users export
// ---------------------------------------------------------------------------

/**
 * A deployment recipe is an async function that receives a {@link DeploymentContext}
 * and performs deployment + setup steps. Recipes are the reusable unit — the
 * same function can run from both tests and CLI.
 *
 * @example
 * ```typescript
 * import type { DeploymentRecipe } from "@lionden/plugin-deploy";
 *
 * export const setupToken: DeploymentRecipe<{ tokenId: string }> = async (ctx) => {
 *   const result = await ctx.deploy("token", { noCompile: true });
 *   await ctx.execute("token.aleo", "mint_public", [ctx.accounts[0].address, "1000u64"]);
 *   return { tokenId: result.programId };
 * };
 * ```
 */
export type DeploymentRecipe<T = void> = (ctx: DeploymentContext) => Promise<T>;
