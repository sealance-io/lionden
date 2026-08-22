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
 *
 * Deleting a variable here only removes the *inherited* value. Leo still falls
 * back to a `.env` file, so anything that must not come from disk has to be
 * assigned — or, for the signing key, refused outright before the spawn.
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
 * **Every variable Leo can read from a `.env` file must be assigned, not
 * deleted.** Leo resolves these from a `.env` in its working directory and
 * every parent of it — the runner's `cwd` is the project root — so an unset
 * variable does not mean "unset", it means "whatever the project's `.env`
 * says". Verified against Leo 4.3.2. That file is the user's own; it is not the
 * materialized package's `.env`, which Leo does not consult for these.
 *
 * The concrete failure for `DEVNET`: a project whose `.env` carries
 * `DEVNET=true` from local devnode work, deployed to a real network. An unset
 * shell variable lets that value win and the deployment goes out in devnet
 * mode. `--devnet` is a valueless flag with no negative form, so an explicit
 * `DEVNET=false` is the only way to force it off.
 *
 * `NETWORK` and `ENDPOINT` are pinned for the same reason. The explicit CLI
 * flags already win, but keeping the environment consistent with them means Leo
 * cannot read a stale value through any path we have not anticipated.
 *
 * `PRIVATE_KEY` is the one case where deleting is not enough on its own, since
 * deleting still leaves the `.env` fallback reachable — so the backend refuses
 * to spawn at all without a key it selected. See `assertSigningKeyPresent`.
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
    // identity lionden did not choose. Deleting it is necessary but not
    // sufficient — Leo would then read the project's `.env` instead — which is
    // why the backend refuses to spawn without a key at all. This branch is
    // reachable only from a direct `buildLeoEnv` call, never through the
    // backend, and it stays as the safer of the two wrong answers.
    delete env["PRIVATE_KEY"];
  }

  return env;
}
