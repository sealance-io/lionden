import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import {
  type ConfigHookHandlers,
  type ConfigValidationError,
  type LionDenPlugin,
  type LionDenRuntimeEnvironment,
  task,
} from "@lionden/core";
import type { NetworkManager } from "@lionden/network";
import { deployAction } from "./deploy-task.js";
import type { DeploymentManager } from "./deployment-manager.js";
import { DeploymentManagerImpl } from "./deployment-manager.js";
import { DeployError } from "./errors.js";
import { recipeAction } from "./recipe-task.js";
import { upgradeAction } from "./upgrade-task.js";

// ---------------------------------------------------------------------------
// Config hooks
// ---------------------------------------------------------------------------

const configHooks: ConfigHookHandlers = {
  validateResolvedConfig(config: LionDenResolvedConfig): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];

    if (config.deploy.defaultPriorityFee < 0) {
      errors.push({
        path: "deploy.defaultPriorityFee",
        message: "Priority fee cannot be negative",
      });
    }

    if (config.deploy.confirmationTimeout <= 0) {
      errors.push({
        path: "deploy.confirmationTimeout",
        message: "Confirmation timeout must be positive",
      });
    }

    if (
      config.deploy.interDeploymentDelay !== undefined &&
      config.deploy.interDeploymentDelay < 0
    ) {
      errors.push({
        path: "deploy.interDeploymentDelay",
        message: "Inter-deployment delay cannot be negative",
      });
    }

    if (
      "deploymentsDir" in config.deploy &&
      typeof (config.deploy as any).deploymentsDir === "string" &&
      (config.deploy as any).deploymentsDir.trim() === ""
    ) {
      errors.push({
        path: "deploy.deploymentsDir",
        message: "Deployments directory cannot be empty",
      });
    }

    return errors;
  },
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const deployTask = task("deploy", "Deploy Aleo programs to a network")
  .addOption({
    name: "program",
    type: "string",
    description: "Deploy only the specified program",
  })
  .addOption({
    name: "priorityFee",
    type: "number",
    description: "Priority fee in microcredits",
  })
  .addFlag({
    name: "skipConfirm",
    description: "Skip waiting for transaction confirmation",
  })
  .addFlag({
    name: "noCompile",
    description: "Skip compilation before deploying (artifacts must already exist)",
  })
  .addFlag({
    name: "preflight",
    description: "Run pre-flight checks only — do not deploy",
  })
  .addFlag({
    name: "dryRun",
    description: "Build transaction but do not broadcast (devnode only)",
  })
  .addFlag({
    name: "noSkipDeployed",
    description: "Fail if any program is already deployed on-chain",
  })
  .addFlag({
    name: "export",
    description: "Export deployment bundle after deploying",
  })
  .setAction(deployAction)
  .build();

const upgradeTask = task("upgrade", "Upgrade a deployed Aleo program")
  .addOption({
    name: "program",
    type: "string",
    description: "Program to upgrade (required)",
    required: true,
  })
  .addOption({
    name: "priorityFee",
    type: "number",
    description: "Priority fee in microcredits",
  })
  .addFlag({
    name: "skipConfirm",
    description: "Skip waiting for transaction confirmation",
  })
  .setAction(upgradeAction)
  .build();

const exportTask = task("export", "Export deployment addresses and ABIs for frontend consumption")
  .addOption({
    name: "out",
    type: "string",
    description: "Output file path (default: deployments/_exports/<network>.json)",
  })
  .setAction(exportAction)
  .build();

const recipeTask = task("recipe", "Run a deployment recipe")
  .addOption({
    name: "file",
    type: "string",
    description: "Path to recipe file (relative to project root)",
    required: true,
  })
  .addOption({
    name: "export",
    type: "string",
    description: "Named export to run (default: 'default')",
  })
  .addFlag({
    name: "noCompile",
    description: "Skip compilation before running recipe",
  })
  .setAction(recipeAction)
  .build();

async function exportAction(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
): Promise<unknown> {
  const networkName = (args["network"] as string | undefined) ?? lre.config.defaultNetwork;
  const outPath = args["out"] as string | undefined;

  const manager = lre.deployments as DeploymentManager | null;
  if (!manager) {
    throw new DeployError(
      "DeploymentManager not available. Ensure @lionden/plugin-deploy is registered as a plugin.",
    );
  }

  const bundle = await manager.export(networkName);

  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(bundle, null, 2));
    console.log(`Exported ${Object.keys(bundle.programs).length} programs to ${outPath}`);
  } else {
    console.log(
      `Exported ${Object.keys(bundle.programs).length} programs for network "${networkName}"`,
    );
  }

  return bundle;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const pluginDeploy: LionDenPlugin = {
  id: "@lionden/plugin-deploy",
  name: "Deploy Plugin",
  hookHandlers: {
    config: configHooks,
  },
  // --prove is a framework built-in global (see arg-names.ts), so it is not
  // declared here. deployAction/upgradeAction still read it via
  // resolveProveOption(), which consults lre.globalOptions["prove"] (seeded by
  // the CLI from the built-in --prove) and LIONDEN_PROVE.
  tasks: [deployTask, upgradeTask, exportTask, recipeTask],
  extendLre(lre: LionDenRuntimeEnvironment): void {
    const networkAccessor = () => lre.network as NetworkManager | null;
    (lre as unknown as Record<string, unknown>)["deployments"] = new DeploymentManagerImpl(
      lre.config,
      networkAccessor,
      lre.artifacts,
    );
  },
};

export default pluginDeploy;

// ---------------------------------------------------------------------------
// Re-exports — public API
// ---------------------------------------------------------------------------

export type { AbiCompatResult, AbiViolation } from "./abi-compat.js";
// ABI compatibility
export { checkAbiCompatibility } from "./abi-compat.js";
export type { ConstructorInfo, ConstructorType } from "./constructor-parser.js";
// Constructor parser
export {
  isValidAleoAddress,
  parseConstructor,
  parseConstructorFromFiles,
} from "./constructor-parser.js";
export type { DeployManifest } from "./deploy-manifest.js";
// Legacy exports (deploy-manifest.ts is left unused; kept for external code that may reference it)
export {
  deployManifestPath,
  readDeployManifest,
  writeDeployManifest,
} from "./deploy-manifest.js";
export type {
  DeployOptions,
  DeployResult,
  DeployTaskResult,
  DryRunResult,
} from "./deploy-task.js";
// Deploy task
export {
  DeployError,
  readLeoSourcesFromDir,
  resolveDeployTargets,
  validateConstructor,
} from "./deploy-task.js";
// Deployment manager
export type { DeploymentManager, PreflightOptions, RecordOptions } from "./deployment-manager.js";
export { DeploymentManagerImpl } from "./deployment-manager.js";
// Deployment state types
export type {
  CompleteDeploymentRecord,
  DegradedDeploymentRecord,
  DeploymentHistoryEntry,
  DeploymentRecord,
  ExportBundle,
  ExportedProgram,
  NetworkMetadata,
  PendingDeployment,
  RecordConstructorInfo,
  RecoveredDeploymentRecord,
} from "./deployment-types.js";
// On-chain check
export { checkProgramOnChain } from "./on-chain-check.js";
// Preflight types
export type {
  DeployPreflightResult,
  PreflightError,
  PreflightWarning,
  ProgramPreflightOutcome,
  UpgradePreflightResult,
} from "./preflight.js";

// Recipe types
export type {
  DeploymentContext,
  DeploymentRecipe,
  ProgramDeploymentTarget,
  RecipeDeployOptions,
  RecipeDeployResult,
  RecipeExecuteOptions,
  RecipeExecuteResult,
} from "./recipe-types.js";
export type { UpgradeOptions, UpgradeResult } from "./upgrade-task.js";
// Upgrade task
export {
  UpgradeCompatibilityError,
  validateAdminSigner,
  validateUpgradePermission,
} from "./upgrade-task.js";
