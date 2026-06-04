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
import { createNamedAccountAccessor } from "@lionden/config";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import { programNameFromTarget } from "@lionden/core";
import type { NetworkConnection, NetworkManager } from "@lionden/network";
import { DEVNODE_ACCOUNTS } from "@lionden/network";
import type { DeploymentManager } from "./deployment-manager.js";
import type { DeploymentRecord } from "./deployment-types.js";
import { DeployError } from "./errors.js";
import type { DeploymentContext } from "./recipe-types.js";

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
  const resolved = path.isAbsolute(file) ? file : path.resolve(lre.config.paths.root, file);
  const mod = await import(resolved);
  const recipeFn = mod[exportName];
  if (typeof recipeFn !== "function") {
    throw new DeployError(`No function "${exportName}" exported from "${file}".`);
  }

  const result = await recipeFn(ctx);
  return result;
}

// ---------------------------------------------------------------------------
// CLI deployment context factory
// ---------------------------------------------------------------------------

export function createCliDeploymentContext(
  lre: LionDenRuntimeEnvironment,
  connection: NetworkConnection,
  networkName: string,
): DeploymentContext {
  return {
    lre,
    connection,
    network: networkName,
    accounts: connection.type === "devnode" ? DEVNODE_ACCOUNTS : [],
    namedAccounts: lre.namedAccounts,
    named: createNamedAccountAccessor(lre.namedAccounts, networkName),

    async deploy(program, opts) {
      const programName = programNameFromTarget(program);
      const normalizedId = normalizeProgramId(programName);
      const deploymentCache = lre.deployments as DeploymentManager | null;

      if (!opts?.noSkipDeployed) {
        const cached = getCachedDeployment(deploymentCache, normalizedId, networkName);
        if (isCompleteDeploymentWithTxId(cached)) {
          return { programId: normalizedId, txId: cached.txId };
        }
      }

      const taskResult = await lre.tasks.run("deploy", {
        program: programName,
        network: networkName,
        noCompile: opts?.noCompile ?? true, // pre-compiled by recipe task
        priorityFee: opts?.priorityFee,
        noSkipDeployed: opts?.noSkipDeployed,
      });

      // Unwrap DeployTaskResult discriminated union
      const wrapped = taskResult as { mode?: string; results?: unknown[] };
      if (wrapped.mode && wrapped.mode !== "deploy") {
        throw new DeployError(
          `Expected deploy task to return mode "deploy", got "${wrapped.mode}". ` +
            `This may indicate --preflight or --dry-run was passed unexpectedly.`,
        );
      }

      const results: Array<{ programId: string; txId: string }> =
        wrapped.mode === "deploy" && Array.isArray(wrapped.results)
          ? (wrapped.results as Array<{ programId: string; txId: string }>)
          : (taskResult as Array<{ programId: string; txId: string }>);

      const deployed = getDeployResultForProgram(results, normalizedId);
      if (deployed) {
        return {
          programId: normalizeProgramId(deployed.programId),
          txId: deployed.txId,
        };
      }

      const cached = getCachedDeployment(deploymentCache, normalizedId, networkName);
      if (isCompleteDeploymentWithTxId(cached)) {
        return { programId: normalizedId, txId: cached.txId };
      }

      throw createEmptyDeployResultError(programName, normalizedId, networkName, cached);
    },

    async execute(programId, transitionName, args, opts) {
      const mode = opts?.mode ?? "onchain";
      const awaitOpt =
        mode === "onchain" ? { awaitConfirmation: opts?.awaitConfirmation ?? true } : {};
      const result = await connection.execute(programId, transitionName, args, {
        mode,
        fee: opts?.fee,
        signer: opts?.signer,
        ...awaitOpt,
      });
      return {
        outputs: result.outputs,
        ...(result.rawOutputs === undefined ? {} : { rawOutputs: result.rawOutputs }),
        txId: result.txId,
      };
    },
  };
}

function normalizeProgramId(programName: string): string {
  return programName.endsWith(".aleo") ? programName : `${programName}.aleo`;
}

function getCachedDeployment(
  deploymentCache: DeploymentManager | null | undefined,
  programId: string,
  networkName: string,
): DeploymentRecord | null {
  return deploymentCache?.getCached(programId, networkName) ?? null;
}

function isCompleteDeploymentWithTxId(
  record: DeploymentRecord | null,
): record is DeploymentRecord & { readonly status: "complete"; readonly txId: string } {
  return record?.status === "complete" && typeof record.txId === "string" && record.txId.length > 0;
}

function getDeployResultForProgram(
  results: Array<{ programId: string; txId: string }>,
  normalizedId: string,
): { programId: string; txId: string } | undefined {
  return (
    results.find((result) => normalizeProgramId(result.programId) === normalizedId) ??
    results[results.length - 1]
  );
}

function createEmptyDeployResultError(
  requestedProgram: string,
  normalizedId: string,
  networkName: string,
  cached: DeploymentRecord | null,
): DeployError {
  return new DeployError(
    `Deploy task produced no transaction for "${requestedProgram}" on network "${networkName}", ` +
      `and no complete cached deployment with a txId exists for "${normalizedId}" ` +
      `(${describeCachedDeployment(cached)}). ` +
      `Use { noSkipDeployed: true } when the recipe must fail instead of reusing or skipping an existing deployment.`,
  );
}

function describeCachedDeployment(cached: DeploymentRecord | null): string {
  if (!cached) {
    return "cached state: none";
  }
  if (cached.status === "complete") {
    return "cached state: complete record without txId";
  }
  return `cached state: ${cached.status} record without txId`;
}
