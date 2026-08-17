/**
 * Contract tests for `collectLocalDeploymentClosure`.
 *
 * This helper was extracted from `resolveDeployTargets`, where the traversal was
 * inlined and its result discarded after ordering. These tests lock the exact
 * pre-extraction behavior — especially the three properties callers depend on:
 * the root is included, ordering comes from `graph.order`, and network deps
 * terminate traversal.
 */

import type { DependencyGraph, DiscoveredProgram } from "@lionden/leo-compiler";
import { describe, expect, it } from "vitest";
import { collectLocalDeploymentClosure } from "./deployment-closure.js";

function makeProgram(id: string): DiscoveredProgram {
  return {
    kind: "program",
    programId: id,
    sourceDir: `/p/${id}`,
    entryFile: `/p/${id}/main.leo`,
    allSources: ["main.leo"],
  };
}

function makeGraph(
  order: DiscoveredProgram[],
  imports: Record<string, string[]> = {},
  networkDeps: string[] = ["credits.aleo"],
): DependencyGraph {
  return {
    order,
    imports: new Map(Object.entries(imports)),
    networkDeps: new Set(networkDeps),
  };
}

function programMapOf(...programs: DiscoveredProgram[]): Map<string, DiscoveredProgram> {
  return new Map(programs.map((p) => [p.programId, p]));
}

describe("collectLocalDeploymentClosure", () => {
  it("includes the root itself", () => {
    const solo = makeProgram("solo.aleo");
    const graph = makeGraph([solo], { "solo.aleo": [] });

    const result = collectLocalDeploymentClosure("solo.aleo", graph, programMapOf(solo));

    expect(result).toEqual(["solo.aleo"]);
  });

  it("includes transitive local dependencies", () => {
    const utils = makeProgram("utils.aleo");
    const token = makeProgram("token.aleo");
    const app = makeProgram("app.aleo");
    const graph = makeGraph([utils, token, app], {
      "utils.aleo": [],
      "token.aleo": ["utils.aleo"],
      "app.aleo": ["token.aleo"],
    });

    const result = collectLocalDeploymentClosure(
      "app.aleo",
      graph,
      programMapOf(utils, token, app),
    );

    expect(result).toEqual(["utils.aleo", "token.aleo", "app.aleo"]);
  });

  it("orders by graph.order, not traversal order", () => {
    // Traversal from `app` visits token before utils, but graph.order says
    // utils comes first. The graph order must win.
    const utils = makeProgram("utils.aleo");
    const token = makeProgram("token.aleo");
    const app = makeProgram("app.aleo");
    const graph = makeGraph([utils, token, app], {
      "app.aleo": ["token.aleo", "utils.aleo"],
      "token.aleo": [],
      "utils.aleo": [],
    });

    const result = collectLocalDeploymentClosure(
      "app.aleo",
      graph,
      programMapOf(utils, token, app),
    );

    expect(result).toEqual(["utils.aleo", "token.aleo", "app.aleo"]);
  });

  it("excludes programs outside the root's closure", () => {
    const utils = makeProgram("utils.aleo");
    const token = makeProgram("token.aleo");
    const unrelated = makeProgram("unrelated.aleo");
    const graph = makeGraph([utils, token, unrelated], {
      "utils.aleo": [],
      "token.aleo": ["utils.aleo"],
      "unrelated.aleo": [],
    });

    const result = collectLocalDeploymentClosure(
      "token.aleo",
      graph,
      programMapOf(utils, token, unrelated),
    );

    expect(result).toEqual(["utils.aleo", "token.aleo"]);
  });

  it("terminates traversal at network dependencies", () => {
    const token = makeProgram("token.aleo");
    const graph = makeGraph(
      [token],
      {
        "token.aleo": ["credits.aleo"],
        // Would be pulled in if credits.aleo were traversed.
        "credits.aleo": ["should_not_appear.aleo"],
      },
      ["credits.aleo"],
    );

    const result = collectLocalDeploymentClosure("token.aleo", graph, programMapOf(token));

    expect(result).toEqual(["token.aleo"]);
  });

  it("does not duplicate a program reached by two paths", () => {
    const utils = makeProgram("utils.aleo");
    const a = makeProgram("a.aleo");
    const b = makeProgram("b.aleo");
    const app = makeProgram("app.aleo");
    const graph = makeGraph([utils, a, b, app], {
      "utils.aleo": [],
      "a.aleo": ["utils.aleo"],
      "b.aleo": ["utils.aleo"],
      "app.aleo": ["a.aleo", "b.aleo"],
    });

    const result = collectLocalDeploymentClosure("app.aleo", graph, programMapOf(utils, a, b, app));

    expect(result).toEqual(["utils.aleo", "a.aleo", "b.aleo", "app.aleo"]);
  });

  it("terminates on a dependency cycle", () => {
    const a = makeProgram("a.aleo");
    const b = makeProgram("b.aleo");
    const graph = makeGraph([a, b], {
      "a.aleo": ["b.aleo"],
      "b.aleo": ["a.aleo"],
    });

    const result = collectLocalDeploymentClosure("a.aleo", graph, programMapOf(a, b));

    expect(result).toEqual(["a.aleo", "b.aleo"]);
  });

  it("traverses through a library without emitting it", () => {
    // Libraries are graph nodes but not deployable programs: traversal passes
    // through them, and they never appear in the closure.
    const utils = makeProgram("utils.aleo");
    const app = makeProgram("app.aleo");
    const graph = makeGraph([utils, app], {
      "app.aleo": ["shared_lib"],
      shared_lib: ["utils.aleo"],
      "utils.aleo": [],
    });

    const result = collectLocalDeploymentClosure("app.aleo", graph, programMapOf(utils, app));

    expect(result).toEqual(["utils.aleo", "app.aleo"]);
  });

  it("appends a root that is absent from graph.order", () => {
    // Safety fallback preserved from resolveDeployTargets: a target that the
    // graph does not know about still gets deployed, last.
    const utils = makeProgram("utils.aleo");
    const orphan = makeProgram("orphan.aleo");
    const graph = makeGraph([utils], { "utils.aleo": [] });

    const result = collectLocalDeploymentClosure("orphan.aleo", graph, programMapOf(utils, orphan));

    expect(result).toEqual(["orphan.aleo"]);
  });

  it("returns a root that is not a known program, via the fallback", () => {
    // Root absent from programMap contributes nothing to `collected`, so only
    // the fallback append keeps it. Locking this because callers subtract the
    // root and would otherwise silently get an empty skip list.
    const graph = makeGraph([], {});

    const result = collectLocalDeploymentClosure("ghost.aleo", graph, programMapOf());

    expect(result).toEqual(["ghost.aleo"]);
  });
});
