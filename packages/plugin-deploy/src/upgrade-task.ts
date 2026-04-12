/**
 * Upgrade task implementation.
 *
 * Validates that the program's constructor permits upgrade, checks ABI
 * compatibility between the deployed and new versions, then builds and
 * broadcasts an upgrade transaction.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { ProgramABI } from "@lionden/leo-compiler";
import {
  discoverUnits,
  parseAbi,
  type DiscoveredProgram,
} from "@lionden/leo-compiler";
import type { NetworkManager, NetworkConnection } from "@lionden/network";
import { readDeployManifest, writeDeployManifest, type DeployManifest } from "./deploy-manifest.js";
import { checkAbiCompatibility, type AbiViolation } from "./abi-compat.js";
import {
  parseConstructor,
  extractConstructorFingerprint,
} from "./constructor-parser.js";
import { DeployError, readLeoSourcesFromDir } from "./deploy-task.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  /** Program to upgrade (required) */
  program: string;
  /** Priority fee in microcredits */
  priorityFee?: number;
  /** Skip waiting for transaction confirmation */
  skipConfirm?: boolean;
  /** Target network (overrides defaultNetwork) */
  network?: string;
}

export interface UpgradeResult {
  readonly programId: string;
  readonly txId: string;
  readonly blockHeight: number;
  readonly newEdition: number;
}

// ---------------------------------------------------------------------------
// Upgrade action
// ---------------------------------------------------------------------------

export async function upgradeAction(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
): Promise<UpgradeResult> {
  const programArg = args["program"] as string | undefined;
  if (!programArg) {
    throw new DeployError(
      "The --program option is required for upgrade. " +
        "Usage: lionden upgrade --program <name>",
    );
  }

  const options: UpgradeOptions = {
    program: programArg,
    priorityFee: args["priorityFee"] as number | undefined,
    skipConfirm: args["skipConfirm"] as boolean | undefined,
    network: args["network"] as string | undefined,
  };

  const config = lre.config;
  const artifactsDir = config.paths.artifacts;
  const programsDir = config.paths.programs;

  // Normalize program ID
  const programId = options.program.endsWith(".aleo")
    ? options.program
    : `${options.program}.aleo`;

  // 1. Read existing deploy manifest
  const manifest = readDeployManifest(artifactsDir, programId);
  if (!manifest) {
    throw new DeployError(
      `No deploy manifest found for "${programId}". ` +
        `Deploy the program first with \`lionden deploy --program ${options.program}\`.`,
    );
  }

  // 2. Validate constructor permits upgrade
  validateUpgradePermission(manifest, programId);

  // 3. Read old ABI and old compiled source BEFORE recompilation
  //    (compilation overwrites both abi.json and main.aleo on disk)
  const oldAbi = readOldAbi(artifactsDir, programId);
  if (!oldAbi) {
    throw new DeployError(
      `No ABI artifact found for "${programId}" at ` +
        `${path.join(artifactsDir, programId, "abi.json")}. ` +
        `Cannot verify upgrade compatibility without the deployed ABI. ` +
        `Re-compile the deployed version first, or re-deploy.`,
    );
  }
  const oldAleoSource = readOldAleoSource(artifactsDir, programId);
  if (!oldAleoSource && manifest.constructorFingerprint === undefined) {
    throw new DeployError(
      `No compiled source artifact found for "${programId}" at ` +
        `${path.join(artifactsDir, programId, "main.aleo")}. ` +
        `Cannot verify constructor immutability without the deployed source. ` +
        `Re-compile the deployed version first, or re-deploy.`,
    );
  }

  // 4. Compile the updated program
  await lre.tasks.run("compile", { program: options.program });

  // 5. Read new ABI from compilation artifacts
  const newAbi = lre.artifacts.getAbi(programId) as ProgramABI | undefined;
  if (!newAbi) {
    throw new DeployError(
      `No compiled ABI found for "${programId}". Compilation may have failed.`,
    );
  }

  // 6. Check ABI compatibility (old vs new)
  const compat = checkAbiCompatibility(oldAbi, newAbi);
  if (!compat.compatible) {
    throw new UpgradeCompatibilityError(programId, compat.violations);
  }

  // 6b. Read compiled Aleo source (needed for constructor fingerprint)
  const aleoSource = lre.artifacts.getAleoSource(programId);
  if (!aleoSource) {
    throw new DeployError(
      `No compiled .aleo source found for "${programId}".`,
    );
  }

  // 7. Discover source directory for constructor parsing (Fix 2)
  const discovered = discoverUnits(programsDir);
  const programs = discovered.filter(
    (u): u is DiscoveredProgram => u.kind === "program",
  );
  const prog = programs.find((p) => p.programId === programId);
  const leoSources = prog
    ? readLeoSourcesFromDir(prog.sourceDir)
    : "";

  const newConstructor = parseConstructor(leoSources);
  if (!newConstructor) {
    throw new DeployError(
      `Updated program "${programId}" has no constructor annotation. ` +
        `ARC-0006 requires a constructor for all deployments/upgrades.`,
    );
  }

  // 7b. Validate constructor hasn't changed (immutable per ARC-0006)
  if (newConstructor.type !== manifest.constructorType) {
    throw new DeployError(
      `Program "${programId}" constructor type changed from ` +
        `"${manifest.constructorType}" to "${newConstructor.type}". ` +
        `Constructors are immutable after first deployment.`,
    );
  }
  if (
    newConstructor.type === "admin" &&
    manifest.constructorAdmin &&
    newConstructor.adminAddress !== manifest.constructorAdmin
  ) {
    throw new DeployError(
      `Program "${programId}" @admin address changed from ` +
        `"${manifest.constructorAdmin}" to "${newConstructor.adminAddress}". ` +
        `Constructor admin address is immutable after first deployment.`,
    );
  }
  if (
    newConstructor.type === "checksum" &&
    manifest.checksumMapping &&
    (newConstructor.checksumMapping !== manifest.checksumMapping ||
      newConstructor.checksumKey !== manifest.checksumKey)
  ) {
    throw new DeployError(
      `Program "${programId}" @checksum parameters changed. ` +
        `Constructor parameters are immutable after first deployment.`,
    );
  }

  // 7c. Compare constructor fingerprint (catches @custom body changes)
  const newFingerprint = extractConstructorFingerprint(
    aleoSource,
    manifest.constructorType,
  );
  if (manifest.constructorFingerprint !== undefined) {
    // Manifest has a stored fingerprint — compare directly
    if (newFingerprint !== manifest.constructorFingerprint) {
      throw new DeployError(
        `Program "${programId}" constructor body changed between versions. ` +
          `Constructors are immutable after first deployment.`,
      );
    }
  } else if (oldAleoSource) {
    // Old manifest predates fingerprinting — backfill from the old
    // compiled source that was on disk before recompilation.
    const oldFingerprint = extractConstructorFingerprint(
      oldAleoSource,
      manifest.constructorType,
    );
    if (newFingerprint !== oldFingerprint) {
      throw new DeployError(
        `Program "${programId}" constructor body changed between versions. ` +
          `Constructors are immutable after first deployment.`,
      );
    }
  }

  // 8. Connect to network
  const networkName = options.network ?? config.defaultNetwork;
  const manager = lre.network as NetworkManager;
  const connection = await manager.connect(networkName);

  // 9. For @admin upgrades, prevalidate the deployer address (Fix 3)
  if (manifest.constructorType === "admin" && manifest.constructorAdmin) {
    await validateAdminSigner(connection, config, networkName, manifest, programId);
  }

  // 10. Build and broadcast upgrade transaction
  const newEdition = manifest.edition + 1;
  const fee = options.priorityFee ?? config.deploy.defaultPriorityFee;

  const txId = await buildAndBroadcastUpgrade({
    programId,
    aleoSource,
    connection,
    fee,
    privateFee: config.deploy.privateFee,
    edition: newEdition,
  });

  // 11. Wait for confirmation
  let blockHeight = 0;
  const shouldConfirm = !options.skipConfirm && config.deploy.confirmTransactions;
  if (shouldConfirm) {
    const confirmed = await connection.waitForConfirmation(
      txId,
      config.deploy.confirmationTimeout,
    );
    if (confirmed.status === "rejected") {
      throw new DeployError(
        `Upgrade transaction ${txId} was rejected on-chain.`,
      );
    }
    blockHeight = confirmed.blockHeight;
  }

  // 12. Update deploy manifest (always persist fingerprint for backfill)
  const updatedManifest: DeployManifest = {
    ...manifest,
    txId,
    blockHeight,
    edition: newEdition,
    constructorFingerprint: newFingerprint,
    deployedAt: new Date().toISOString(),
  };

  writeDeployManifest(artifactsDir, updatedManifest);

  console.log(
    `Upgraded ${programId} to edition ${newEdition} (tx: ${txId}, block: ${blockHeight})`,
  );

  return { programId, txId, blockHeight, newEdition };
}

// ---------------------------------------------------------------------------
// Upgrade validation
// ---------------------------------------------------------------------------

/**
 * Check that the existing deployment's constructor permits upgrade.
 */
export function validateUpgradePermission(
  manifest: DeployManifest,
  programId: string,
): void {
  switch (manifest.constructorType) {
    case "noupgrade":
      throw new DeployError(
        `Program "${programId}" was deployed with @noupgrade and cannot be upgraded.`,
      );

    case "admin":
      // Admin upgrade is allowed — signer check happens in validateAdminSigner
      break;

    case "checksum":
      // Checksum upgrade is allowed — on-chain checksum validation happens during broadcast
      break;

    case "custom":
      console.warn(
        `Warning: Program "${programId}" uses @custom constructor. ` +
          `Custom constructor logic will be evaluated on-chain during upgrade.`,
      );
      break;

    default:
      throw new DeployError(
        `Program "${programId}" has unknown constructor type "${manifest.constructorType}". ` +
          `Cannot determine upgrade eligibility.`,
      );
  }
}

/**
 * Prevalidate that the configured signer matches the @admin address (Fix 3).
 *
 * Resolves the deployer's address from the network config's private key and
 * compares it to the manifest's admin address. Rejects early if they don't
 * match, instead of deferring to the SDK at broadcast time.
 */
export async function validateAdminSigner(
  connection: NetworkConnection,
  config: import("@lionden/config").LionDenResolvedConfig,
  networkName: string,
  manifest: DeployManifest,
  programId: string,
): Promise<void> {
  const adminAddress = manifest.constructorAdmin;
  if (!adminAddress) return;

  // Determine the deployer's address from the network configuration
  const networkConfig = config.networks[networkName];
  if (!networkConfig) {
    throw new DeployError(
      `Cannot upgrade "${programId}": network "${networkName}" not found in config. ` +
        `The program has @admin(address="${adminAddress}") and the signer must be verified before upgrade.`,
    );
  }

  let signerAddress: string | undefined;

  if (networkConfig.type === "devnode") {
    // For devnode: use first configured account, or fall back to well-known account-0
    if (networkConfig.accounts.length > 0) {
      // We have the private key — derive the address via the SDK
      signerAddress = await deriveAddressFromKey(
        networkConfig.accounts[0]!.privateKey,
        connection,
      );
    } else {
      // Fall back to well-known devnode account-0
      const { DEVNODE_ACCOUNTS } = await import("@lionden/network");
      signerAddress = DEVNODE_ACCOUNTS[0]!.address;
    }
  } else if (networkConfig.type === "http" && networkConfig.privateKey) {
    signerAddress = await deriveAddressFromKey(
      networkConfig.privateKey,
      connection,
    );
  }

  if (!signerAddress) {
    throw new DeployError(
      `Cannot upgrade "${programId}": unable to determine the signer address ` +
        `for network "${networkName}". The program has @admin(address="${adminAddress}") ` +
        `and the signer must be verified before upgrade. ` +
        `Ensure the network config includes a private key or uses a devnode with accounts.`,
    );
  }

  if (signerAddress !== adminAddress) {
    throw new DeployError(
      `Program "${programId}" has @admin(address="${adminAddress}") but the ` +
        `configured signer address is "${signerAddress}". ` +
        `Only the admin address can upgrade this program.`,
    );
  }
}

/**
 * Derive the Aleo address from a private key using the SDK.
 */
async function deriveAddressFromKey(
  privateKey: string,
  connection: NetworkConnection,
): Promise<string | undefined> {
  try {
    const { createSdkObjects } = await import("@lionden/network");
    const sdk = await createSdkObjects({
      network: connection.networkId,
      endpoint: connection.endpoint,
      privateKey,
      apiKey: connection.apiKey,
    });
    return sdk.account.address().to_string();
  } catch (err) {
    console.warn(
      `Warning: SDK address derivation failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Admin signer prevalidation skipped.`,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ABI compatibility error
// ---------------------------------------------------------------------------

export class UpgradeCompatibilityError extends DeployError {
  readonly violations: readonly AbiViolation[];

  constructor(programId: string, violations: readonly AbiViolation[]) {
    const details = violations
      .map((v) => `  - [${v.kind}] ${v.detail}`)
      .join("\n");
    super(
      `Upgrade of "${programId}" is not ABI-compatible with the deployed version:\n${details}`,
    );
    this.name = "UpgradeCompatibilityError";
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Transaction building
// ---------------------------------------------------------------------------

interface BuildUpgradeOptions {
  programId: string;
  aleoSource: string;
  connection: NetworkConnection;
  fee: number;
  privateFee: boolean;
  edition: number;
}

async function buildAndBroadcastUpgrade(
  opts: BuildUpgradeOptions,
): Promise<string> {
  const { programId, aleoSource, connection, fee, privateFee, edition } = opts;

  const { createSdkObjects, checkDevnodeSdkSupport, initConsensusHeights } =
    await import("@lionden/network");

  if (connection.type === "devnode") {
    await checkDevnodeSdkSupport();
    await initConsensusHeights();
  }

  const sdk = await createSdkObjects({
    network: connection.networkId,
    endpoint: connection.endpoint,
    privateKey: connection.privateKey,
    apiKey: connection.apiKey,
  });

  if (
    connection.type === "devnode"
  ) {
    const tx = await sdk.programManager.buildDevnodeUpgradeTransaction({
      program: aleoSource,
      priorityFee: fee,
      privateFee,
    });

    return connection.broadcastTransaction(tx);
  }

  // Standard upgrade — use buildUpgradeTransaction + manual broadcast
  const pm = sdk.programManager as any;
  if (typeof pm.buildUpgradeTransaction === "function") {
    const tx = await pm.buildUpgradeTransaction({
      program: aleoSource,
      priorityFee: fee,
      privateFee,
    });
    return connection.broadcastTransaction(tx);
  }

  // Fallback: try legacy upgrade() if available on older SDK versions
  if (typeof pm.upgrade === "function") {
    return pm.upgrade(aleoSource, fee, edition);
  }

  throw new DeployError(
    `Unable to upgrade "${programId}": no suitable upgrade method found on ProgramManager. ` +
      `Ensure @provablehq/sdk@^0.10.1 is installed.`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readOldAbi(
  artifactsDir: string,
  programId: string,
): ProgramABI | null {
  const abiPath = path.join(artifactsDir, programId, "abi.json");
  if (!fs.existsSync(abiPath)) return null;

  const raw = fs.readFileSync(abiPath, "utf-8");
  return parseAbi(raw);
}

function readOldAleoSource(
  artifactsDir: string,
  programId: string,
): string | null {
  const sourcePath = path.join(artifactsDir, programId, "main.aleo");
  if (!fs.existsSync(sourcePath)) return null;
  return fs.readFileSync(sourcePath, "utf-8");
}

