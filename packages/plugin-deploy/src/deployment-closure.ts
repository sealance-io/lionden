/**
 * Local deployment closure resolution.
 *
 * A program's "local deployment closure" is the set of locally-discovered
 * programs that must exist on-chain for it to work: itself plus every program
 * it transitively imports, excluding network dependencies (which are already
 * deployed and are fetched, not built).
 *
 * This lives in its own module because three call sites need it and they do not
 * share a code path: `resolveDeployTargets` (ordering), the deploy/dry-run
 * transaction builders, and the upgrade action. Before extraction the traversal
 * ran only inside `resolveDeployTargets`'s targeted-program branch and its result
 * was discarded after ordering.
 */

import type { DependencyGraph, DiscoveredProgram } from "@lionden/leo-compiler";

/**
 * Programs in `rootId`'s local dependency closure, in topological order.
 *
 * Contract — all three points are load-bearing for callers:
 *
 * - **Includes `rootId` itself** when it is present in `programMap`. Callers that
 *   want "dependencies only" must subtract `rootId` themselves.
 * - **Ordered by `graph.order`** (dependencies first), not by traversal order.
 *   `rootId` is appended when it is absent from the graph, preserving the
 *   pre-extraction safety fallback.
 * - **`rootId` must be a node in `graph`.** For a renamed deploy or upgrade that
 *   means the *source* program id — the effective (post-rename) id does not exist
 *   in the source graph, so passing it would silently yield an empty closure.
 *
 * Network dependencies (`graph.networkDeps`) terminate traversal: they are
 * resolved from chain, never deployed by us.
 */
export function collectLocalDeploymentClosure(
  rootId: string,
  graph: DependencyGraph,
  programMap: ReadonlyMap<string, DiscoveredProgram>,
): string[] {
  const collected = new Set<string>();
  collectTransitiveProgramDeps(rootId, graph, programMap, collected);

  const ordered: string[] = [];
  for (const unit of graph.order) {
    if (unit.kind === "program" && collected.has(unit.programId)) {
      ordered.push(unit.programId);
    }
  }
  // Ensure the root is included even if it is not in the graph.
  if (!ordered.includes(rootId)) ordered.push(rootId);

  return ordered;
}

function collectTransitiveProgramDeps(
  unitId: string,
  graph: DependencyGraph,
  programMap: ReadonlyMap<string, DiscoveredProgram>,
  collected: Set<string>,
  visited: Set<string> = new Set(),
): void {
  if (visited.has(unitId)) return;
  visited.add(unitId);

  if (programMap.has(unitId)) {
    collected.add(unitId);
  }

  const deps = graph.imports.get(unitId) ?? [];
  for (const dep of deps) {
    if (graph.networkDeps.has(dep)) continue;
    collectTransitiveProgramDeps(dep, graph, programMap, collected, visited);
  }
}
