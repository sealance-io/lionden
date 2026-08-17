/**
 * Deployer/admin address derivation.
 *
 * Collapses the three near-identical "build an SDK bundle for one address"
 * blocks that previously lived inline in `deploy-task.ts`, `upgrade-task.ts`,
 * and `preflight.ts`.
 *
 * Deliberately a free function over `NetworkConnection` rather than a method on
 * it: adding a required member to the `NetworkConnection` interface would break
 * every external implementor, and the connection's own SDK bundle carries
 * `keyCache` — which address derivation must not touch (see
 * `deriveAddressFromPrivateKey`).
 */

import type { ResolvedNetworkConfig } from "@lionden/config";
import type { NetworkConnection } from "@lionden/network";

/**
 * Derive the address for `privateKey` over `connection`'s network coordinates.
 * Best-effort — returns `undefined` if derivation fails, matching what all
 * three former call sites did.
 */
export async function tryDeriveAddress(
  connection: NetworkConnection,
  privateKey: string,
): Promise<string | undefined> {
  try {
    const { deriveAddressFromPrivateKey } = await import("@lionden/network");
    return await deriveAddressFromPrivateKey(
      privateKey,
      connection.networkId,
      connection.endpoint,
      connection.apiKey,
      connection.egressPolicy,
    );
  } catch {
    return undefined;
  }
}

/**
 * Resolve the address that will pay for and sign a deploy or upgrade.
 *
 * Precedence: an explicit signer override (the named `deployer` / `admin`
 * account), then the connection's configured key, then a devnode's first
 * built-in account. Returns `undefined` when no key is available at all —
 * callers record `"unknown"` provenance rather than failing.
 */
export async function resolveDeployerAddress(
  connection: NetworkConnection,
  networkConfig: ResolvedNetworkConfig,
  signerPrivateKey?: string,
): Promise<string | undefined> {
  const privateKey =
    signerPrivateKey ??
    connection.privateKey ??
    (networkConfig.type === "devnode" && networkConfig.accounts.length > 0
      ? networkConfig.accounts[0]!.privateKey
      : undefined);

  if (!privateKey) return undefined;

  return tryDeriveAddress(connection, privateKey);
}
