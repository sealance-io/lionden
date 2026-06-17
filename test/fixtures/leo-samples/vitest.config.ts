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
export default defineConfig({
  test: {
    root: ".",
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
