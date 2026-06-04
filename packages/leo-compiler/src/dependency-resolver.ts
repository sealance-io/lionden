import { parseImports } from "./import-parser.js";
import type { DiscoveredUnit } from "./types.js";
import { unitId } from "./types.js";

export class CircularDependencyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(" → ")}`);
    this.name = "CircularDependencyError";
  }
}

export class MissingDependencyError extends Error {
  constructor(
    public readonly unitId: string,
    public readonly missingDep: string,
  ) {
    super(
      `Unit "${unitId}" depends on "${missingDep}" which is not a local project unit and not a known network dependency`,
    );
    this.name = "MissingDependencyError";
  }
}

export interface DependencyGraph {
  /** Units in topological compile order (dependencies before dependents) */
  readonly order: DiscoveredUnit[];
  /** Map from unit ID to its external dependency IDs (both local and network) */
  readonly imports: ReadonlyMap<string, string[]>;
  /** Set of network dependencies (not local units, e.g. "credits.aleo") */
  readonly networkDeps: ReadonlySet<string>;
}

/**
 * Build a dependency graph from discovered units by parsing imports from all
 * .leo source files. Returns units in topological compile order.
 *
 * Local project units (programs and libraries) are resolved as local deps.
 * All other imports (e.g. credits.aleo) are classified as network deps.
 */
export function resolveDependencies(units: DiscoveredUnit[]): DependencyGraph {
  // Build lookup by all possible IDs a unit can be referenced as
  const unitById = new Map<string, DiscoveredUnit>();
  for (const unit of units) {
    unitById.set(unitId(unit), unit);
    // Libraries can also be imported as "<name>.aleo" in Leo source
    if (unit.kind === "library") {
      unitById.set(`${unit.name}.aleo`, unit);
    }
  }

  // Parse imports for each unit, normalizing local dep names to canonical unitId
  const importsMap = new Map<string, string[]>();
  const networkDeps = new Set<string>();
  const localAdj = new Map<string, string[]>(); // unitId -> [local dep unitIds]

  for (const unit of units) {
    const rawImports = parseImports(unit.sourceDir, unit.allSources);
    const id = unitId(unit);
    const normalizedImports: string[] = [];
    const localDeps: string[] = [];

    for (const dep of rawImports) {
      const resolved = unitById.get(dep);
      if (resolved) {
        // Normalize to canonical unitId (e.g. "math.aleo" → "math" for libraries)
        const canonicalId = unitId(resolved);
        normalizedImports.push(canonicalId);
        localDeps.push(canonicalId);
      } else {
        // Network dependency (credits.aleo, etc.)
        normalizedImports.push(dep);
        networkDeps.add(dep);
      }
    }

    importsMap.set(id, normalizedImports);
    localAdj.set(id, localDeps);
  }

  // Topological sort via DFS with cycle detection
  const order: DiscoveredUnit[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // currently in DFS stack

  function visit(id: string, stack: string[]): void {
    if (visited.has(id)) return;

    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      throw new CircularDependencyError([...stack.slice(cycleStart), id]);
    }

    visiting.add(id);
    stack.push(id);

    for (const dep of localAdj.get(id) ?? []) {
      visit(dep, stack);
    }

    stack.pop();
    visiting.delete(id);
    visited.add(id);

    const unit = unitById.get(id);
    if (unit) order.push(unit);
  }

  for (const unit of units) {
    visit(unitId(unit), []);
  }

  return { order, imports: importsMap, networkDeps };
}
