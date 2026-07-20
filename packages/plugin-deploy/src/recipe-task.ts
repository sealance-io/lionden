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
import { createNamedAccountAccessor, normalizeProgramId } from "@lionden/config";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import { logAction, programNameFromTarget, sourceProgramNameFromTarget } from "@lionden/core";
import type { NetworkConnection, NetworkManager } from "@lionden/network";
import { DEVNODE_ACCOUNTS } from "@lionden/network";
import type { DeploymentManager } from "./deployment-manager.js";
import type { DeploymentRecord } from "./deployment-types.js";
import { DeployError } from "./errors.js";
import { resolveProveOption } from "./prove.js";
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
  // Capture the explicit network separately from the resolved `networkName`: only
  // an explicitly-supplied network is forwarded into the implicit compile, so a
  // default run (no `network` arg) leaves compile on `config.defaultNetwork`.
  const explicitNetwork =
    typeof args["network"] === "string" ? (args["network"] as string) : undefined;
  const networkName = explicitNetwork ?? lre.config.defaultNetwork;
  const noCompile = (args["noCompile"] as boolean) ?? false;

  // 1. Compile first (unless --no-compile). Forward the explicit network so the
  // implicit compile resolves imported on-chain sources + `.env` from the
  // deploying network; omit it on a default run (byte-for-byte unchanged).
  if (!noCompile) {
    if (explicitNetwork) {
      await lre.tasks.run("compile", { network: explicitNetwork });
    } else {
      await lre.tasks.run("compile");
    }
  }

  // 2. Connect to network
  const networkManager = lre.network as NetworkManager;
  const connection = await networkManager.connect(networkName);

  // 3. Create deployment context. Resolve the run-level prove preference once
  // (programmatic args.prove → --prove global → LIONDEN_PROVE → false) so
  // ctx.execute inherits it; per-call opts can still override.
  const resolvedRecipeProve = resolveProveOption(args, lre);
  const ctx = createCliDeploymentContext(lre, connection, networkName, resolvedRecipeProve);

  // 4. Import and run recipe — resolve relative to project root, not cwd
  const resolved = path.isAbsolute(file) ? file : path.resolve(lre.config.paths.root, file);
  const mod = await import(resolved);
  const recipeFn = mod[exportName];
  if (typeof recipeFn !== "function") {
    throw new DeployError(`No function "${exportName}" exported from "${file}".`);
  }

  console.log(
    `${logAction("Running recipe")} ${resolved}#${exportName} on network "${networkName}"`,
  );

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
  resolvedProve = false,
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
      const sourceProgramName = sourceProgramNameFromTarget(program);
      const normalizedId = normalizeProgramId(programName);
      const normalizedSourceId = normalizeProgramId(sourceProgramName);
      const rename = normalizedSourceId === normalizedId ? undefined : normalizedId;
      const expectedSourceProgramId = rename ? normalizedSourceId : undefined;
      const defaultNoCompile = !rename;
      const deploymentCache = lre.deployments as DeploymentManager | null;

      if (!opts?.noSkipDeployed) {
        const cached = getCachedDeployment(deploymentCache, normalizedId, networkName);
        if (isCompleteMatchingRecord(cached, normalizedId, expectedSourceProgramId)) {
          return { programId: normalizedId, txId: cached.txId };
        }
      }

      const taskResult = await lre.tasks.run("deploy", {
        program: rename ? normalizedSourceId : programName,
        ...(rename ? { rename } : {}),
        network: networkName,
        noCompile: opts?.noCompile ?? defaultNoCompile,
        priorityFee: opts?.priorityFee,
        noSkipDeployed: opts?.noSkipDeployed,
        // Forward the recipe's authoritative prove value (a per-call override
        // wins; otherwise inherit the run-level `resolvedProve`), mirroring
        // ctx.execute. resolvedProve already encodes the full args > --prove >
        // LIONDEN_PROVE precedence, so passing it explicitly keeps deploy and
        // execute consistent — including programmatic `tasks.run("recipe", {
        // prove })` and an explicit `{ prove: false }` that must beat a truthy
        // ambient env (Finding 2 escape hatch + run-level inheritance).
        prove: opts?.prove ?? resolvedProve,
      });

      if (rename) {
        const results = getDeployResults(taskResult);
        const deployed = getDeployResultForProgram(results, normalizedId);
        if (deployed) {
          return {
            programId: normalizeProgramId(deployed.programId),
            txId: deployed.txId,
          };
        }

        const cached = getCachedDeployment(deploymentCache, normalizedId, networkName);
        if (isCompleteMatchingRecord(cached, normalizedId, expectedSourceProgramId)) {
          return { programId: normalizedId, txId: cached.txId };
        }

        throw createEmptyDeployResultError(programName, normalizedId, networkName, cached, true);
      }

      const results = getDeployResults(taskResult);
      const deployed = getDeployResultForProgram(results, normalizedId);
      if (deployed) {
        return {
          programId: normalizeProgramId(deployed.programId),
          txId: deployed.txId,
        };
      }

      const cached = getCachedDeployment(deploymentCache, normalizedId, networkName);
      if (isCompleteMatchingRecord(cached, normalizedId)) {
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
        prove: opts?.prove ?? resolvedProve,
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
  return results.find((result) => normalizeProgramId(result.programId) === normalizedId);
}

function getDeployResults(taskResult: unknown): Array<{ programId: string; txId: string }> {
  const wrapped = taskResult as { mode?: string; results?: unknown[] };
  if (wrapped.mode !== "deploy") {
    throw new DeployError(
      `Expected deploy task to return mode "deploy", got "${wrapped.mode}". ` +
        `This may indicate --preflight or --dry-run was passed unexpectedly.`,
    );
  }
  if (!Array.isArray(wrapped.results)) {
    throw new DeployError('Expected deploy task to return { mode: "deploy", results: [...] }.');
  }
  return wrapped.results as Array<{ programId: string; txId: string }>;
}

function isCompleteMatchingRecord(
  record: DeploymentRecord | null | undefined,
  normalizedId: string,
  expectedSourceProgramId?: string,
): record is DeploymentRecord & { readonly status: "complete"; readonly txId: string } {
  const maybeRecord = record ?? null;
  if (!isCompleteDeploymentWithTxId(maybeRecord)) return false;
  if (expectedSourceProgramId === undefined) {
    return (
      maybeRecord.sourceProgramId === undefined || maybeRecord.sourceProgramId === normalizedId
    );
  }
  return (
    maybeRecord.programId === normalizedId &&
    maybeRecord.sourceProgramId === expectedSourceProgramId
  );
}

function createEmptyDeployResultError(
  requestedProgram: string,
  normalizedId: string,
  networkName: string,
  cached: DeploymentRecord | null,
  expectsRename = false,
): DeployError {
  const cacheRequirement = expectsRename
    ? "no complete cached deployment with matching rename provenance exists"
    : "no complete cached deployment with a txId exists";
  return new DeployError(
    `Deploy task produced no transaction for "${requestedProgram}" on network "${networkName}", ` +
      `and ${cacheRequirement} for "${normalizedId}" ` +
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
