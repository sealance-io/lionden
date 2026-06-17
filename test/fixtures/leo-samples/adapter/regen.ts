/**
 * Regenerate every lane project under `generated/` from the `.upstream`
 * submodule (idempotent), copying any committed authored suite into each
 * project's `test/` dir. Invoked by scripts/run-leo-samples.mjs before the
 * in-process and on-chain phases. Run directly with:
 *
 *   node --import tsx test/fixtures/leo-samples/adapter/regen.ts
 */
import { adaptSampleGroup, assertUpstreamPresent, DEFAULT_UPSTREAM_ROOT } from "./adapt.js";
import { LANE_PROJECTS } from "./specs.js";

async function main(): Promise<void> {
  assertUpstreamPresent(DEFAULT_UPSTREAM_ROOT);
  for (const spec of LANE_PROJECTS) {
    const project = await adaptSampleGroup(spec);
    const suiteCount = project.manifest.units.length;
    console.log(
      `adapted ${spec.name}: ${suiteCount} unit(s), topo [${project.manifest.topoOrder.join(", ")}]` +
        (spec.compileOnly ? " (compile-only)" : ""),
    );
  }
  console.log(`\nRegenerated ${LANE_PROJECTS.length} project(s) under generated/.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
