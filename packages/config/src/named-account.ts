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

/** Resolved named accounts keyed by role name. A role may be absent. */
export type NamedAccounts = Readonly<Partial<Record<string, NamedAccount>>>;

/** Named account role contract used by the context-level named account DSL. */
export type NamedAccountRole = "signer" | "address";

/** Reusable named account contract for recipes and tests. */
export type NamedAccountSpec = Record<string, NamedAccountRole>;

type ResolveNamedAccountRole<R extends NamedAccountRole> = R extends "signer"
  ? SignableNamedAccount
  : NamedAccount;

export interface NamedAccountAccessor {
  /**
   * Return a required signable account.
   *
   * @example
   * ```typescript
   * const deployer = ctx.named.signer("deployer");
   * await ctx.execute("prog.aleo", "admin_fn", [], { signer: deployer });
   * ```
   */
  signer(name: string): SignableNamedAccount;

  /**
   * Return a required account where an address is sufficient.
   *
   * The "address" contract returns the full NamedAccount, not a bare address
   * string, so callers can still pass the value to APIs that accept NamedAccount.
   *
   * @example
   * ```typescript
   * const treasury = ctx.named.address("treasury");
   * await ctx.execute("token.aleo", "mint_public", [treasury.address, "1000u64"]);
   * ```
   */
  address(name: string): NamedAccount;

  /**
   * Validate a recipe-local named account contract and return typed accounts.
   *
   * Inline object literals infer literal role values without `as const`.
   *
   * @example
   * ```typescript
   * const { deployer, treasury } = ctx.named.require({
   *   deployer: "signer",
   *   treasury: "address",
   * });
   * ```
   */
  require<const Spec extends NamedAccountSpec>(
    spec: Spec,
  ): { [K in keyof Spec]: ResolveNamedAccountRole<Spec[K]> };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard — returns true if the account can sign transactions.
 *
 * @example
 * ```typescript
 * const maybeAdmin = ctx.namedAccounts.admin;
 * if (isSignable(maybeAdmin)) {
 *   await ctx.execute("prog.aleo", "admin_fn", [], { signer: maybeAdmin });
 * }
 * ```
 *
 * When working from a DeploymentContext or TestContext, prefer
 * `ctx.named.signer(...)` or `ctx.named.require(...)` for required roles.
 */
export function isSignable(
  account: NamedAccount | null | undefined,
): account is SignableNamedAccount {
  return account?.type === "signable";
}

export function createNamedAccountAccessor(
  accounts: NamedAccounts,
  networkName: string,
): NamedAccountAccessor {
  const requireOne = <Role extends NamedAccountRole>(
    name: string,
    role: Role,
  ): ResolveNamedAccountRole<Role> => {
    const failure = getRoleFailure(accounts, name, role);
    if (failure) {
      throw new Error(formatNamedAccountContractError(networkName, [failure]));
    }
    return accounts[name] as ResolveNamedAccountRole<Role>;
  };

  return {
    signer(name) {
      return requireOne(name, "signer");
    },

    address(name) {
      return requireOne(name, "address");
    },

    require(spec) {
      const failures: string[] = [];
      const result: Partial<Record<keyof typeof spec, NamedAccount>> = {};

      for (const [name, role] of Object.entries(spec) as Array<
        [keyof typeof spec & string, NamedAccountRole]
      >) {
        const failure = getRoleFailure(accounts, name, role);
        if (failure) {
          failures.push(failure);
          continue;
        }
        result[name] = accounts[name];
      }

      if (failures.length > 0) {
        throw new Error(formatNamedAccountContractError(networkName, failures));
      }

      return result as {
        [K in keyof typeof spec]: ResolveNamedAccountRole<(typeof spec)[K]>;
      };
    },
  };
}

/**
 * Return a configured named account or throw a clear configuration error.
 *
 * @example
 * ```typescript
 * const treasury = requireNamedAccount(ctx.namedAccounts, "treasury");
 * await ctx.execute("token.aleo", "mint_public", [treasury.address, "1000u64"]);
 * ```
 *
 * @deprecated Prefer `ctx.named.address(...)` or `ctx.named.require(...)`
 * when working from a DeploymentContext or TestContext.
 */
export function requireNamedAccount(accounts: NamedAccounts, name: string): NamedAccount {
  const account = accounts[name];
  if (!account) {
    throw new Error(
      `Named account "${name}" is not configured. ` +
        `Add it to namedAccounts in your LionDen config.`,
    );
  }
  return account;
}

/**
 * Return a configured signable named account or throw a clear configuration error.
 *
 * @example
 * ```typescript
 * const deployer = requireSignableNamedAccount(ctx.namedAccounts, "deployer");
 * await ctx.execute("prog.aleo", "admin_fn", [], { signer: deployer });
 * ```
 *
 * @deprecated Prefer `ctx.named.signer(...)` or `ctx.named.require(...)`
 * when working from a DeploymentContext or TestContext.
 */
export function requireSignableNamedAccount(
  accounts: NamedAccounts,
  name: string,
): SignableNamedAccount {
  const account = requireNamedAccount(accounts, name);
  if (!isSignable(account)) {
    throw new Error(
      `Named account "${name}" is address-only and cannot be used as a signer. ` +
        `Configure a private key or devnode account index for this role.`,
    );
  }
  return account;
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
 *
 * @deprecated Prefer passing values from `ctx.named.signer(...)` or
 * signer roles returned by `ctx.named.require(...)` directly.
 */
export function asSigner(account: NamedAccount): {
  readonly privateKey: string;
  readonly address: string;
} {
  if (account.type !== "signable") {
    throw new Error(
      `Named account "${account.name}" is address-only and cannot be used as a signer. ` +
        `Configure a private key or devnode account index for this role.`,
    );
  }
  return { privateKey: account.privateKey, address: account.address };
}

function getRoleFailure(
  accounts: NamedAccounts,
  name: string,
  role: NamedAccountRole,
): string | undefined {
  const account = accounts[name];
  if (!account) {
    return `"${name}" is not configured`;
  }
  if (role === "signer" && !isSignable(account)) {
    return `"${name}" is address-only but the contract requires a signer`;
  }
  return undefined;
}

function formatNamedAccountContractError(networkName: string, failures: readonly string[]): string {
  return [
    `Named accounts contract failed for network "${networkName}":`,
    ...failures.map((failure) => `  - ${failure}`),
  ].join("\n");
}
