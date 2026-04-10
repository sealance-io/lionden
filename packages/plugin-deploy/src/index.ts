import {
  type LionDenPlugin,
  type ConfigHookHandlers,
  type ConfigValidationError,
  task,
} from "@lionden/core";
import type { LionDenResolvedConfig } from "@lionden/config";
import { deployAction } from "./deploy-task.js";
import { upgradeAction } from "./upgrade-task.js";

// ---------------------------------------------------------------------------
// Config hooks
// ---------------------------------------------------------------------------

const configHooks: ConfigHookHandlers = {
  validateResolvedConfig(config: LionDenResolvedConfig): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];

    // Validate deploy config values
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
  .addOption({
    name: "network",
    type: "string",
    description: "Target network (overrides default)",
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
  .addOption({
    name: "network",
    type: "string",
    description: "Target network (overrides default)",
  })
  .setAction(upgradeAction)
  .build();

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const pluginDeploy: LionDenPlugin = {
  id: "@lionden/plugin-deploy",
  name: "Deploy Plugin",
  hookHandlers: {
    config: configHooks,
  },
  tasks: [deployTask, upgradeTask],
};

export default pluginDeploy;

// Re-export public types and utilities
export {
  DeployError,
  validateConstructor,
  readLeoSourcesFromDir,
  resolveDeployTargets,
} from "./deploy-task.js";
export type { DeployOptions, DeployResult } from "./deploy-task.js";
export {
  UpgradeCompatibilityError,
  validateUpgradePermission,
  validateAdminSigner,
} from "./upgrade-task.js";
export type { UpgradeOptions, UpgradeResult } from "./upgrade-task.js";
export {
  parseConstructor,
  parseConstructorFromFiles,
  isValidAleoAddress,
  type ConstructorInfo,
  type ConstructorType,
} from "./constructor-parser.js";
export {
  checkAbiCompatibility,
  type AbiCompatResult,
  type AbiViolation,
} from "./abi-compat.js";
export {
  readDeployManifest,
  writeDeployManifest,
  deployManifestPath,
  type DeployManifest,
} from "./deploy-manifest.js";
