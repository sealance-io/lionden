/**
 * Adapter unit test (Tier 1 — runs in the normal unit lane).
 *
 * Adapts each upstream sample group into a temp dir and asserts that lionden's
 * own discovery/resolution sees the intended units, topo order, imports, and
 * network deps — i.e. the source-first materialization + bare-library
 * reconciliation produced the graph the spec promises. No `leo build` (that is
 * the 0f proof's job), so this stays fast and Leo-free.
 *
 * Skips when the submodule is absent so the unit lane never breaks on a missing
 * checkout; the lane runner (scripts/run-leo-samples.mjs) always inits it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverUnits, resolveDependencies, unitId } from "@lionden/leo-compiler";
import { afterAll, describe, expect, it } from "vitest";
import { adaptSampleGroup, DEFAULT_UPSTREAM_ROOT } from "./adapt.js";
import { makeOfflineFetchNetworkDep } from "./offline-network-dep.js";
import { getSpec, SPECS } from "./specs.js";
import { upstreamReady } from "./test-support.js";

const ready = upstreamReady(DEFAULT_UPSTREAM_ROOT);
const tmpRoots: string[] = [];

function freshRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-samples-adapt-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)("adaptSampleGroup", () => {
  for (const spec of SPECS) {
    it(`adapts ${spec.name} into the expected resolved graph`, async () => {
      const project = await adaptSampleGroup(spec, { outputRoot: freshRoot() });

      // Re-run discovery/resolution on the on-disk output (not the adapter's
      // own manifest) to prove the materialized tree is independently correct.
      const units = discoverUnits(project.programsDir);
      const graph = resolveDependencies(units);

      expect(units.map((u) => unitId(u)).sort()).toEqual([...spec.expected.units].sort());
      expect(graph.order.map((u) => unitId(u)).sort()).toEqual([...spec.expected.units].sort());

      // Dependencies-before-dependents ordering.
      const position = new Map(graph.order.map((u, i) => [unitId(u), i]));
      for (const [id, deps] of graph.imports) {
        for (const dep of deps) {
          if (position.has(dep)) {
            expect(position.get(dep)!, `${dep} must precede ${id}`).toBeLessThan(position.get(id)!);
          }
        }
      }

      // Per-unit imports + network deps match the spec.
      for (const [id, expectedDeps] of Object.entries(spec.expected.imports)) {
        expect([...(graph.imports.get(id) ?? [])].sort()).toEqual([...expectedDeps].sort());
      }
      expect([...graph.networkDeps].sort()).toEqual([...spec.expected.networkDeps].sort());

      // The adapter's serialized manifest agrees with fresh resolution.
      expect(project.manifest.topoOrder).toEqual(graph.order.map((u) => unitId(u)));
      expect([...project.manifest.networkDeps].sort()).toEqual(
        [...spec.expected.networkDeps].sort(),
      );

      // Scaffolding exists.
      expect(fs.existsSync(project.configPath)).toBe(true);
      expect(fs.existsSync(path.join(project.projectDir, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(project.projectDir, "tsconfig.json"))).toBe(true);
      expect(fs.existsSync(project.manifestPath)).toBe(true);
    });
  }

  it("reconciles bare-library references only in external_composition", async () => {
    const ec = await adaptSampleGroup(getSpec("external_composition"), { outputRoot: freshRoot() });
    // Libraries were rewritten into the consuming programs + the dependent lib.
    expect(ec.manifest.rewrites["abi_consumer/main.leo"]).toEqual([
      "abi_point_lib",
      "abi_shape_lib",
    ]);
    expect(ec.manifest.rewrites["abi_shape_lib/lib.leo"]).toEqual(["abi_point_lib"]);

    // Program entry files get an `import <lib>.aleo;`; library entry files must
    // NOT (Leo forbids imports in libraries).
    const consumerSrc = fs.readFileSync(
      path.join(ec.programsDir, "abi_consumer", "main.leo"),
      "utf-8",
    );
    expect(consumerSrc).toContain("import abi_point_lib.aleo;");
    expect(consumerSrc).toContain("abi_point_lib.aleo::Point");
    const libSrc = fs.readFileSync(path.join(ec.programsDir, "abi_shape_lib", "lib.leo"), "utf-8");
    expect(libSrc).not.toContain("import abi_point_lib.aleo;");
    expect(libSrc).toContain("abi_point_lib.aleo::Point");

    // Projects without libraries are copied verbatim.
    const nre = await adaptSampleGroup(getSpec("native_runtime_edges"), {
      outputRoot: freshRoot(),
    });
    expect(nre.manifest.rewrites).toEqual({});
  });

  it("renders execution.imports for dynamic dispatch targets", async () => {
    const dd = await adaptSampleGroup(getSpec("dynamic_dispatch"), { outputRoot: freshRoot() });
    const config = fs.readFileSync(dd.configPath, "utf-8");
    expect(config).toContain('"dispatcher.aleo": ["token_iface.aleo", "token_alt.aleo"]');
    expect(config).toContain("pluginLeo");
    expect(config).toContain('leoVersion: "4.2.0"');
  });

  it("serves the vendored credits.aleo via the offline injector", async () => {
    const offline = makeOfflineFetchNetworkDep();
    const src = await offline("credits.aleo", "http://unused", "testnet");
    expect(src.startsWith("program credits.aleo;")).toBe(true);
    await expect(offline("not_vendored.aleo", "http://unused")).rejects.toThrow(
      /No vendored network dependency/,
    );
  });
});
