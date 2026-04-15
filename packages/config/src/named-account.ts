/**
 * Named account runtime types and helpers.
 *
 * A named account maps a human-readable role (e.g. "deployer", "admin",
 * "treasury") to a resolved account value. Two shapes exist:
 *
 * - SignableNamedAccount: has a private key — can sign transactions.
 *   Structurally satisfies the Signer interface from @lionden/network
 *   (both have `privateKey` and `address`), so it can be passed directly
 *   to ExecuteOptions.signer without an adapter.
 *
 * - AddressOnlyNamedAccount: address only — cannot sign. Useful for roles
 *   like a treasury receiver where you only need to reference the address.
 *
 * These types live in @lionden/config (zero deps) so that @lionden/core,
 * @lionden/network, and the plugin packages can all import them without
 * creating circular dependencies.
 */

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

export interface SignableNamedAccount {
  readonly type: "signable";
  /** The role name (e.g. "deployer", "admin"). */
  readonly name: string;
  /** The Aleo address derived from the private key. */
  readonly address: string;
  /** The private key for this account. */
  readonly privateKey: string;
}

export interface AddressOnlyNamedAccount {
  readonly type: "address-only";
  /** The role name (e.g. "treasury"). */
  readonly name: string;
  /** The Aleo address for this account. */
  readonly address: string;
}

/** A resolved named account — either signable or address-only. */
export type NamedAccount = SignableNamedAccount | AddressOnlyNamedAccount;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard — returns true if the account can sign transactions.
 *
 * @example
 * ```typescript
 * const admin = ctx.namedAccounts.admin;
 * if (!isSignable(admin)) throw new Error("admin must be signable");
 * await ctx.execute("prog.aleo", "admin_fn", [], { signer: admin });
 * ```
 */
export function isSignable(account: NamedAccount): account is SignableNamedAccount {
  return account.type === "signable";
}

/**
 * Extract the structural signer shape `{ privateKey, address }` from a named account.
 *
 * Throws if the account is address-only (no private key available).
 *
 * Returns a plain object — intentionally does NOT import `Signer` from
 * @lionden/network to preserve the zero-dep constraint of this package.
 * The returned shape structurally satisfies `Signer` in all consuming packages.
 *
 * @example
 * ```typescript
 * import { asSigner } from "@lionden/config";
 * await ctx.execute("prog.aleo", "transfer", [amount], { signer: asSigner(ctx.namedAccounts.deployer) });
 * ```
 */
export function asSigner(account: NamedAccount): { readonly privateKey: string; readonly address: string } {
  if (account.type !== "signable") {
    throw new Error(
      `Named account "${account.name}" is address-only and cannot be used as a signer. ` +
        `Configure a private key or devnode account index for this role.`,
    );
  }
  return { privateKey: account.privateKey, address: account.address };
}
