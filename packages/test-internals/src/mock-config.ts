import type { LionDenResolvedConfig } from "@lionden/config";

/**
 * Create a fully populated LionDenResolvedConfig for tests.
 *
 * Produces a devnode-only config by default. Pass `overrides` to
 * customize individual fields or add extra networks.
 *
 * @example
 * ```ts
 * // Default config with /tmp/test root
 * const config = createMockConfig();
 *
 * // Custom root (e.g., from a temp dir)
 * const config = createMockConfig({ root: tmpDir });
 *
 * // Add a testnet HTTP network alongside devnode
 * const config = createMockConfig({
 *   networks: {
 *     devnode: { type: "devnode", socketAddr: "127.0.0.1:3030", autoBlock: true, verbosity: 0, accounts: [], network: "testnet" },
 *     testnet: { type: "http", endpoint: "https://api.explorer.provable.com/v1", network: "testnet" },
 *   },
 * });
 * ```
 */
export function createMockConfig(
  overrides: Partial<LionDenResolvedConfig> & { root?: string } = {},
): LionDenResolvedConfig {
  const { root = "/tmp/test", paths: pathsOverride, ...rest } = overrides;

  const paths = pathsOverride ?? {
    root,
    programs: `${root}/programs`,
    artifacts: `${root}/artifacts`,
    typechain: `${root}/typechain`,
    cache: `${root}/cache`,
  };

  return {
    leoVersion: "4.0.0",
    paths,
    networks: {
      devnode: {
        type: "devnode",
        socketAddr: "127.0.0.1:3030",
        autoBlock: true,
        verbosity: 0,
        accounts: [],
        network: "testnet",
      },
    },
    defaultNetwork: "devnode",
    compiler: {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    },
    codegen: { enabled: true, outDir: "typechain" },
    testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
    deploy: {
      defaultPriorityFee: 0,
      privateFee: false,
      confirmTransactions: true,
      confirmationTimeout: 60_000,
    },
    ...rest,
  } as LionDenResolvedConfig;
}
