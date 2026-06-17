import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchNetworkDep } from "@lionden/leo-compiler";

/**
 * Default location of the vendored network-dependency snapshots, relative to
 * this module (`test/fixtures/leo-samples/network-deps/`).
 */
export const VENDORED_NETWORK_DEPS_DIR = fileURLToPath(new URL("../network-deps", import.meta.url));

/**
 * Build a {@link FetchNetworkDep} that serves vendored, pinned network-dep
 * sources from disk instead of hitting a live REST endpoint.
 *
 * `compilePipeline` calls `defaultFetchNetworkDep`, which performs a real
 * `fetch()` against the configured endpoint and *throws* when it is
 * unreachable — it never starts a devnode. A cold-cache compile of a program
 * that imports `credits.aleo` (e.g. `native_runtime_edges`) therefore fails
 * unless a node is already up. Passing this offline fetcher into
 * `compilePipeline(config, options, makeOfflineFetchNetworkDep())` makes the
 * compile hermetic and deterministic: no devnode, no network, pinned source.
 *
 * The vendored snapshot under `network-deps/<programId>` must be the on-chain
 * program text the REST endpoint would return (i.e. what `leo build` writes
 * into `imports/`), pinned to the same consensus version the fixtures target
 * (V15). See `network-deps/credits.aleo`.
 */
export function makeOfflineFetchNetworkDep(
  networkDepsDir: string = VENDORED_NETWORK_DEPS_DIR,
): FetchNetworkDep {
  return async (programId: string): Promise<string> => {
    const file = path.join(networkDepsDir, programId);
    if (!fs.existsSync(file)) {
      const available = fs.existsSync(networkDepsDir)
        ? fs.readdirSync(networkDepsDir).join(", ")
        : "(directory missing)";
      throw new Error(
        `No vendored network dependency for "${programId}" under ${networkDepsDir}.\n` +
          `Available snapshots: ${available}\n` +
          `Vendor the V15 on-chain source as network-deps/${programId} or run the ` +
          `on-chain phases against a live devnode instead of the offline fetcher.`,
      );
    }
    return fs.readFileSync(file, "utf-8");
  };
}
