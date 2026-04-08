/**
 * Pre-funded signer management for tests.
 *
 * Wraps the well-known devnode accounts and provides helpers for
 * assigning distinct signers to different test scenarios.
 */

import type { DevnodeAccount } from "@lionden/network";
import { DEVNODE_ACCOUNTS, getDefaultAccount } from "@lionden/network";

export { DEVNODE_ACCOUNTS, getDefaultAccount };

/**
 * Get a devnode account by index (0-3).
 * Throws if index is out of range.
 */
export function getAccount(index: number): DevnodeAccount {
  if (index < 0 || index >= DEVNODE_ACCOUNTS.length) {
    throw new RangeError(
      `Account index ${index} out of range. ` +
        `Devnode provides ${DEVNODE_ACCOUNTS.length} accounts (0-${DEVNODE_ACCOUNTS.length - 1}).`,
    );
  }
  return DEVNODE_ACCOUNTS[index]!;
}

/**
 * Get all devnode account addresses.
 */
export function getAddresses(): string[] {
  return DEVNODE_ACCOUNTS.map((a) => a.address);
}

/**
 * Get a devnode account by its address.
 * Returns undefined if no account matches.
 */
export function getAccountByAddress(address: string): DevnodeAccount | undefined {
  return DEVNODE_ACCOUNTS.find((a) => a.address === address);
}
