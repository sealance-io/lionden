/**
 * Child-process environment for the Leo CLI.
 *
 * Two rules, both load-bearing:
 *
 * 1. The private key travels here and **never in argv**, following
 *    `runRestoreCommand` in `devnode-manager.ts` — argv is world-readable
 *    through the process list.
 * 2. `DEVNET` is always set to a literal `"true"` or `"false"`, never merely
 *    deleted. See `buildLeoEnv` for why deletion is unsafe.
 */

import type { AleoNetwork } from "@lionden/config";

export interface LeoEnvOptions {
  readonly networkId: AleoNetwork;
  readonly endpoint: string;
  readonly connectionType: "devnode" | "http";
  readonly privateKey?: string;
}

/**
 * Build the child environment explicitly, starting from `process.env`.
 *
 * **`DEVNET` must be assigned, not deleted.** `buildDotEnv` writes
 * `DEVNET=true` into the materialized package's `.env` for devnode networks,
 * and Leo loads that file from the package directory (walking up the tree), so
 * an unset shell variable simply lets the file's value win. The concrete
 * failure that guards against: a package materialized against a devnode and
 * later deployed to HTTP with `--noCompile` — so never re-materialized — would
 * run in devnet mode against a real network. `--devnet` is a valueless flag, so
 * an explicit `DEVNET=false` is the only way to force it off.
 *
 * `NETWORK` and `ENDPOINT` are set for the same reason: the package `.env`
 * carries whatever network it was materialized for, which is not necessarily
 * the one being deployed to now. The explicit CLI flags already win, but
 * keeping the environment consistent with them means Leo cannot read a stale
 * value through any path we have not anticipated.
 */
export function buildLeoEnv(options: LeoEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NETWORK: options.networkId,
    ENDPOINT: options.endpoint,
    DEVNET: options.connectionType === "devnode" ? "true" : "false",
  };

  if (options.privateKey !== undefined) {
    env["PRIVATE_KEY"] = options.privateKey;
  } else {
    // An inherited key from the parent shell would silently sign with an
    // identity lionden did not choose.
    delete env["PRIVATE_KEY"];
  }

  return env;
}
