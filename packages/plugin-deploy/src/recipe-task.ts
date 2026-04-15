/**
 * Recipe task — run a deployment recipe from the CLI.
 *
 * A recipe is a user-defined async function exported from a TypeScript/JS file.
 * The task compiles the project once, creates a DeploymentContext, then calls
 * the recipe function.
 *
 * Usage:
 *   lionden recipe --file ./recipes/setup.ts
 *   lionden recipe --file ./recipes/setup.ts --export setupToken
 *   lionden recipe --file ./recipes/setup.ts --network testnet
 */

import * as path from "node:path";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { NetworkManager, NetworkConnection } from "@lionden/network";
import { DEVNODE_ACCOUNTS } from "@lionden/network";
import type { DeploymentContext } from "./recipe-types.js";
import { DeployError } from "./errors.js";

// ---------------------------------------------------------------------------
// Recipe action
// ---------------------------------------------------------------------------

export async function recipeAction(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
): Promise<unknown> {
  const file = args["file"] as string | undefined;
  if (!file) {
    throw new DeployError(
      "The --file option is required.\nUsage: lionden recipe --file ./recipes/setup.ts",
    );
  }
  const exportName = (args["export"] as string) ?? "default";
  const networkName = (args["network"] as string) ?? lre.config.defaultNetwork;
  const noCompile = (args["noCompile"] as boolean) ?? false;

  // 1. Compile first (unless --no-compile)
  if (!noCompile) {
    await lre.tasks.run("compile");
  }

  // 2. Connect to network
  const networkManager = lre.network as NetworkManager;
  const connection = await networkManager.connect(networkName);

  // 3. Create deployment context
  const ctx = createCliDeploymentContext(lre, connection, networkName);

  // 4. Import and run recipe — resolve relative to project root, not cwd
  const resolved = path.isAbsolute(file)
    ? file
    : path.resolve(lre.config.paths.root, file);
  const mod = await import(resolved);
  const recipeFn = mod[exportName];
  if (typeof recipeFn !== "function") {
    throw new DeployError(
      `No function "${exportName}" exported from "${file}".`,
    );
  }

  const result = await recipeFn(ctx);
  return result;
}

// ---------------------------------------------------------------------------
// CLI deployment context factory
// ---------------------------------------------------------------------------

function createCliDeploymentContext(
  lre: LionDenRuntimeEnvironment,
  connection: NetworkConnection,
  networkName: string,
): DeploymentContext {
  return {
    lre,
    connection,
    network: networkName,
    accounts: connection.type === "devnode" ? DEVNODE_ACCOUNTS : [],

    async deploy(programName, opts) {
      const taskResult = await lre.tasks.run("deploy", {
        program: programName,
        network: networkName,
        noCompile: opts?.noCompile ?? true, // pre-compiled by recipe task
        priorityFee: opts?.priorityFee,
      });

      // Unwrap DeployTaskResult discriminated union
      const wrapped = taskResult as { mode?: string; results?: unknown[] };
      const results: Array<{ programId: string; txId: string }> =
        wrapped.mode === "deploy" && Array.isArray(wrapped.results)
          ? (wrapped.results as Array<{ programId: string; txId: string }>)
          : (taskResult as Array<{ programId: string; txId: string }>);

      const last = results[results.length - 1];
      if (!last) {
        throw new DeployError(
          `Deploy task returned no results for "${programName}".`,
        );
      }
      return { programId: last.programId, txId: last.txId };
    },

    async execute(programId, transitionName, args, opts) {
      const result = await connection.execute(programId, transitionName, args, {
        mode: opts?.mode ?? "onchain",
        fee: opts?.fee,
        signer: opts?.signer,
      });
      return { outputs: result.outputs, txId: result.txId };
    },
  };
}
