import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Standalone Vitest config for the leo-samples lane's *in-process* suites:
 * the 0f adapter-proof gate and the Phase-2 compile + codegen coverage suite.
 * Both build each project's config explicitly and drive `compilePipeline`
 * directly, so they run many projects in one process without per-project
 * config discovery (unlike the on-chain suites, which run via `runTests()`
 * per generated project — see scripts/run-leo-samples.mjs).
 *
 * Coverage targets `packages/**` so the new suites credit lionden source.
 */

// When the runner is merging coverage (the full `--coverage` lane), it sets
// LEO_SAMPLES_INPROC_COVERAGE_BLOB to a path inside the shared blobDir. Emit the
// in-process run's coverage as a blob *result* reporter — a sibling of
// `test.coverage`, byte-shape identical to the on-chain side's `resolveReporters`
// (test-runner.ts) — so the runner's `--merge-reports` unions the codegen-path
// coverage that the on-chain `lionden test` cache-skips. Env-gated, so the plain
// (non-coverage) lane is unchanged.
const inProcessCoverageBlob = process.env["LEO_SAMPLES_INPROC_COVERAGE_BLOB"];

/**
 * Map `@lionden/*` to each package's `src/index.ts` so the codegen path is
 * EXECUTED from source. Mirrors plugin-test's `resolveCoverageAliases`: without
 * it the suite resolves `@lionden/*` to built `dist` (the packages' only
 * `exports` entry), V8 attributes coverage to `dist`, and the `src`-targeted
 * include credits 0%. The on-chain blobs are likewise src-keyed (via the same
 * alias), so this is also what lets `--merge-reports` union the two on the same
 * files. Gated on the blob env so the plain (non-coverage) lane keeps running
 * dist, unchanged.
 */
function resolveSourceAliases(): Record<string, string> | undefined {
  const packagesDir = join(process.cwd(), "packages");
  if (!existsSync(packagesDir)) return undefined;
  const aliases: Record<string, string> = {};
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(packagesDir, entry.name);
    const packageJsonPath = join(packageRoot, "package.json");
    const sourceEntrypoint = join(packageRoot, "src", "index.ts");
    if (!existsSync(packageJsonPath) || !existsSync(sourceEntrypoint)) continue;
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string") aliases[pkg.name] = sourceEntrypoint;
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

const sourceAliases = inProcessCoverageBlob ? resolveSourceAliases() : undefined;

export default defineConfig({
  ...(sourceAliases ? { resolve: { alias: sourceAliases } } : {}),
  test: {
    root: ".",
    ...(inProcessCoverageBlob
      ? { reporters: [["blob", { outputFile: inProcessCoverageBlob }]] }
      : {}),
    // The 0f proof gate + Phase-2 compile/codegen suite — both hermetic (no
    // devnode). The port-override spike (adapter/port-spike.test.ts) boots a
    // real devnode and is intentionally NOT here; run it on demand:
    //   vitest run --config <this> test/fixtures/leo-samples/adapter/port-spike.test.ts
    include: [
      "test/fixtures/leo-samples/adapter/proof.test.ts",
      "test/fixtures/leo-samples/compile-codegen.test.ts",
    ],
    // Real `leo build` per unit — generous default for cold compiles.
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // Each suite drives a shared on-disk artifacts tree; keep them serialized.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.d.ts"],
      reporter: ["text-summary"],
    },
  },
});
