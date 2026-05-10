/**
 * NamedAccountManager — resolves named account config to runtime NamedAccount values.
 *
 * Called during NetworkManager.connect() after a connection is established.
 * For private key entries, address derivation is performed via the SDK here,
 * so callers have `lre.namedAccounts` available immediately after connect().
 */

import type {
  ResolvedNamedAccountsConfig,
  NamedAccounts,
  NamedAccount,
  SignableNamedAccount,
  AddressOnlyNamedAccount,
} from "@lionden/config";
import type { AleoNetwork } from "@lionden/config";
import { DEVNODE_ACCOUNTS } from "./accounts.js";

export interface ResolveForNetworkOptions {
  networkName: string;
  networkType: "devnode" | "http";
  networkId: AleoNetwork;
  endpoint: string;
  apiKey?: string;
}

export class NamedAccountManager {
  private readonly config: ResolvedNamedAccountsConfig;
  /** Cache: networkName → resolved accounts */
  private readonly cache = new Map<string, NamedAccounts>();

  constructor(config: ResolvedNamedAccountsConfig) {
    this.config = config;
  }

  /**
   * Resolve all named accounts for the given network.
   *
   * Results are cached per network name and returned from cache on repeated calls.
   * Cache is cleared by `invalidate()` (called from `NetworkManagerImpl.disconnectAll()`).
   */
  async resolveForNetwork(
    opts: ResolveForNetworkOptions,
  ): Promise<NamedAccounts> {
    const { networkName } = opts;

    const cached = this.cache.get(networkName);
    if (cached) {
      return cached;
    }

    const result: Record<string, NamedAccount> = {};

    for (const [accountName, entry] of Object.entries(this.config)) {
      // Pick value: network-specific override if present, else default, else error
      const value =
        entry.networks[networkName] !== undefined
          ? entry.networks[networkName]
          : entry.default;

      if (value === undefined) {
        throw new Error(
          `Named account "${accountName}" has no value for network "${networkName}" and no default. ` +
            `Add a "default" or a "${networkName}" override in your namedAccounts config.`,
        );
      }

      const account = await this.resolveValue(accountName, value, opts);
      result[accountName] = account;
    }

    const frozen = Object.freeze(result);
    this.cache.set(networkName, frozen);
    return frozen;
  }

  /** Clear all cached resolved accounts (called on disconnectAll). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Remove a single network's cached entry (not currently used but available). */
  invalidateNetwork(networkName: string): void {
    this.cache.delete(networkName);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resolveValue(
    accountName: string,
    value: ResolvedNamedAccountsConfig[string]["networks"][string],
    opts: ResolveForNetworkOptions,
  ): Promise<NamedAccount> {
    const { networkName, networkType } = opts;

    switch (value.type) {
      case "index": {
        if (networkType === "http") {
          throw new Error(
            `Named account "${accountName}" uses devnode account index ${value.index}, ` +
              `but network "${networkName}" is an HTTP network. ` +
              `Provide an explicit private key or address override for "${networkName}".`,
          );
        }
        if (value.index >= DEVNODE_ACCOUNTS.length) {
          throw new Error(
            `Named account "${accountName}" references devnode account index ${value.index}, ` +
              `but only ${DEVNODE_ACCOUNTS.length} devnode accounts exist (indices 0–${DEVNODE_ACCOUNTS.length - 1}).`,
          );
        }
        const devAccount = DEVNODE_ACCOUNTS[value.index]!;
        const signable: SignableNamedAccount = {
          type: "signable",
          name: accountName,
          address: devAccount.address,
          privateKey: devAccount.privateKey,
        };
        return signable;
      }

      case "address": {
        const addressOnly: AddressOnlyNamedAccount = {
          type: "address-only",
          name: accountName,
          address: value.address,
        };
        return addressOnly;
      }

      case "privateKey": {
        const address = await deriveAddressFromPrivateKey(
          value.privateKey,
          opts.networkId,
          opts.endpoint,
          opts.apiKey,
        );
        const signable: SignableNamedAccount = {
          type: "signable",
          name: accountName,
          address,
          privateKey: value.privateKey,
        };
        return signable;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Address derivation
// ---------------------------------------------------------------------------

/**
 * Derive the Aleo address for a private key using the Provable SDK.
 * Address derivation is a local operation — no network calls required.
 */
async function deriveAddressFromPrivateKey(
  privateKey: string,
  network: AleoNetwork,
  endpoint: string,
  apiKey?: string,
): Promise<string> {
  const { createSdkObjects } = await import("./sdk-adapter.js");
  const sdk = await createSdkObjects({ network, endpoint, privateKey, apiKey });
  const account = sdk.account as unknown as { address(): { to_string(): string } };
  return account.address().to_string();
}
