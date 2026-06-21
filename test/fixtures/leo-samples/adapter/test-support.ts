import * as fs from "node:fs";
import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import { networkDepCacheScope } from "@lionden/leo-compiler";
import { VENDORED_NETWORK_DEPS_DIR } from "./offline-network-dep.js";

/**
 * Build a minimal `LionDenResolvedConfig` for in-process compile coverage,
 * pointing at an adapted project's `programs/` + a project-local `artifacts/`.
 *
 * Mirrors the inline config in `packages/leo-compiler/src/compiler.test.ts`.
 * Targets Leo 4.1.0 / devnode `testnet` so the network-dep cache scope and
 * `.env` match the fixtures; pass `makeOfflineFetchNetworkDep()` to
 * `compilePipeline` to stay hermetic (no devnode).
 */
export function makeResolvedConfig(
  projectDir: string,
  programsDir: string,
  overrides?: Partial<LionDenResolvedConfig>,
): LionDenResolvedConfig {
  return {
    leoVersion: "4.1.0",
    skipLeoVersionCheck: false,
    leoBinary: "leo",
    paths: {
      root: projectDir,
      programs: programsDir,
      artifacts: path.join(projectDir, "artifacts"),
      typechain: path.join(projectDir, "typechain"),
      cache: path.join(projectDir, ".cache"),
      deployments: path.join(projectDir, "deployments"),
    },
    networks: {
      devnode: {
        type: "devnode",
        socketAddr: "127.0.0.1:3030",
        autoBlock: true,
        verbosity: 0,
        accounts: [],
        network: "testnet",
        ephemeral: true,
      },
    },
    defaultNetwork: "devnode",
    compiler: { enableDce: true, conditionalBlockMaxDepth: 10, buildTests: false, extraFlags: [] },
    codegen: { enabled: false, outDir: "typechain", dynamicRecords: {} },
    testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
    deploy: {
      defaultPriorityFee: 0,
      privateFee: false,
      confirmTransactions: true,
      confirmationTimeout: 60_000,
      deploymentsDir: "deployments",
      skipDeployed: true,
      autoExport: false,
    },
    sdk: { keyCache: { storage: "memory" } },
    execution: { imports: {} },
    namedAccounts: {},
    ...overrides,
  };
}

/** True when the leo-samples submodule has been checked out. */
export function upstreamReady(upstreamRoot: string): boolean {
  return fs.existsSync(path.join(upstreamRoot, "README.md"));
}

/**
 * Pre-seed the network-dependency cache with vendored snapshots so the real
 * `compile` task (which uses the live REST fetcher, not the offline injector)
 * compiles hermetically — a cache hit means `fetchNetworkDep` is never called.
 * Use this when driving `lre.tasks.run("compile")` for codegen coverage; for
 * pure compile coverage prefer passing `makeOfflineFetchNetworkDep()` directly.
 *
 * The cache scope is derived by the compiler's own `networkDepCacheScope` helper
 * (single source of truth — see `packages/leo-compiler/src/compiler.ts`), so the
 * seeded snapshots can never drift from where the pipeline reads them. The
 * compile here is non-overridden, so the effective network is the config's
 * `defaultNetwork`.
 */
export function seedNetworkDepCache(
  config: LionDenResolvedConfig,
  depNames: readonly string[],
  vendoredDir: string = VENDORED_NETWORK_DEPS_DIR,
): void {
  if (depNames.length === 0) return;
  const { scope } = networkDepCacheScope(config, config.defaultNetwork);
  const scopeDir = path.join(config.paths.artifacts, ".cache", "network-deps", scope);
  fs.mkdirSync(scopeDir, { recursive: true });
  for (const dep of depNames) {
    const src = path.join(vendoredDir, dep);
    // Fail loudly: a missing vendored snapshot would silently fall back to a
    // live REST fetch on the next compile (network access in CI), defeating the
    // hermetic guarantee. Surface it as a clear error naming the absent file.
    if (!fs.existsSync(src)) {
      throw new Error(
        `seedNetworkDepCache: no vendored snapshot for "${dep}" at ${src}. ` +
          `Vendor it under ${vendoredDir} or remove it from the seed list — ` +
          `otherwise the next compile would fetch it over the network.`,
      );
    }
    fs.copyFileSync(src, path.join(scopeDir, dep));
  }
}
