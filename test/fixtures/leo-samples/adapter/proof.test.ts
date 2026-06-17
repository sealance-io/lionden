/**
 * Phase 0f — adapter-proof gate (BLOCKING).
 *
 * Proves the two riskiest adapter paths against the real Leo toolchain before
 * any on-chain suite is authored:
 *
 *  - `native_runtime_edges` — cold-compiles via `compilePipeline` with the
 *    offline `credits.aleo` injector (no devnode, no network).
 *  - `external_composition` — locks the documented lionden finding that
 *    library-qualified struct *type paths* (`<lib>.aleo::Type`) cannot be
 *    code-generated. If this ever starts compiling, the gate fails and the
 *    exclusion must be re-evaluated.
 *
 * Requires the submodule (`git submodule update --init`) and Leo 4.1.0 on PATH;
 * skips cleanly when the submodule is absent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compilePipeline, type ProgramCompilationResult, unitId } from "@lionden/leo-compiler";
import { afterAll, describe, expect, it } from "vitest";
import { adaptSampleGroup, DEFAULT_UPSTREAM_ROOT } from "./adapt.js";
import { makeOfflineFetchNetworkDep } from "./offline-network-dep.js";
import { getSpec } from "./specs.js";
import { makeResolvedConfig, upstreamReady } from "./test-support.js";

const ready = upstreamReady(DEFAULT_UPSTREAM_ROOT);
const offline = makeOfflineFetchNetworkDep();
const tmpRoots: string[] = [];

function freshRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-samples-proof-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)("0f adapter-proof gate (BLOCKING)", () => {
  it("native_runtime_edges cold-compiles with the offline credits.aleo injector", async () => {
    const project = await adaptSampleGroup(getSpec("native_runtime_edges"), {
      outputRoot: freshRoot(),
    });
    const config = makeResolvedConfig(project.projectDir, project.programsDir);

    const { results, graph } = await compilePipeline(config, {}, offline);

    const programs = results.filter(
      (r): r is ProgramCompilationResult => r.unit.kind === "program",
    );
    expect(programs.map((p) => p.unit.programId).sort()).toEqual([
      "credit_left.aleo",
      "credit_right.aleo",
      "native_runtime_edges.aleo",
    ]);
    for (const p of programs) {
      expect(p.abi.program).toBe(p.unit.programId);
      expect(p.abi.transitions.length).toBeGreaterThan(0);
    }

    // credits.aleo resolved offline as a network dep.
    expect([...graph.networkDeps]).toContain("credits.aleo");

    // The compiler's resolved graph matches the manifest the adapter wrote.
    assertGraphMatchesManifest(graph, project.manifest);
  });

  it("external_composition fails — locks the bare-library struct-type-path finding", async () => {
    const spec = getSpec("external_composition");
    expect(spec.excluded).toBeDefined();
    const project = await adaptSampleGroup(spec, { outputRoot: freshRoot() });
    const config = makeResolvedConfig(project.projectDir, project.programsDir);

    // Adaptation itself is correct (the resolved graph matches the spec) —
    // only `leo build` fails, which is the whole point of the finding.
    expect([...project.manifest.topoOrder].sort()).toEqual([...spec.expected.units].sort());

    let caught: unknown;
    try {
      await compilePipeline(config, {}, offline);
    } catch (err) {
      caught = err;
    }
    expect(
      caught,
      "external_composition unexpectedly compiled — re-evaluate the exclusion",
    ).toBeDefined();
    const e = caught as { message?: string; stderr?: string };
    const haystack = `${e.message ?? ""}\n${e.stderr ?? ""}`;
    expect(haystack).toContain(spec.excluded!.errorMarker);
  });
});

interface GraphLike {
  readonly order: ReadonlyArray<{ kind: string }>;
  readonly imports: ReadonlyMap<string, string[]>;
  readonly networkDeps: ReadonlySet<string>;
}

function assertGraphMatchesManifest(
  graph: GraphLike,
  manifest: {
    topoOrder: readonly string[];
    imports: Readonly<Record<string, readonly string[]>>;
    networkDeps: readonly string[];
  },
): void {
  expect(graph.order.map((u) => unitId(u as never))).toEqual(manifest.topoOrder);
  expect([...graph.networkDeps].sort()).toEqual([...manifest.networkDeps].sort());
  for (const [id, deps] of graph.imports) {
    expect([...deps].sort(), `imports mismatch for ${id}`).toEqual(
      [...(manifest.imports[id] ?? [])].sort(),
    );
  }
}
