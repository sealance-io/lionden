/**
 * Admin signer validation — extracted to break circular dependencies.
 *
 * Both preflight.ts and upgrade-task.ts need validateAdminSigner; this module
 * lets both import it without creating a cycle.
 */

import type { LionDenResolvedConfig } from "@lionden/config";
import type { NetworkConnection } from "@lionden/network";
import { DeployError } from "./errors.js";

/**
 * Derive the Aleo address from a private key using the SDK.
 * Returns undefined and logs a warning on failure (non-fatal for preflight).
 */
export async function deriveAddressFromKey(
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
      egressPolicy: connection.egressPolicy,
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

/**
 * Prevalidate that the configured signer matches the @admin address.
 *
 * Resolves the deployer's address from the network config's private key and
 * compares it to the admin address. Throws a DeployError early if they don't
 * match, instead of deferring the failure to SDK broadcast time.
 *
 * @param adminAddress - The expected admin address from the deployment record
 * @param programId - Used only for error messages
 */
export async function validateAdminSigner(
  connection: NetworkConnection,
  config: LionDenResolvedConfig,
  networkName: string,
  adminAddress: string,
  programId: string,
  signerPrivateKey?: string,
): Promise<void> {
  let signerAddress: string | undefined;

  // If an explicit signer key is provided, use it directly (namedAccounts.admin)
  if (signerPrivateKey) {
    signerAddress = await deriveAddressFromKey(signerPrivateKey, connection);
  } else {
    const networkConfig = config.networks[networkName];
    if (!networkConfig) {
      throw new DeployError(
        `Cannot upgrade "${programId}": network "${networkName}" not found in config. ` +
          `The program has @admin(address="${adminAddress}") and the signer must be verified before upgrade.`,
      );
    }

    if (networkConfig.type === "devnode") {
      if (networkConfig.accounts.length > 0) {
        signerAddress = await deriveAddressFromKey(
          networkConfig.accounts[0]!.privateKey,
          connection,
        );
      } else {
        const { DEVNODE_ACCOUNTS } = await import("@lionden/network");
        signerAddress = DEVNODE_ACCOUNTS[0]!.address;
      }
    } else if (networkConfig.type === "http" && networkConfig.privateKey) {
      signerAddress = await deriveAddressFromKey(networkConfig.privateKey, connection);
    }
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
