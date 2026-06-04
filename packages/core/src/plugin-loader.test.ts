import { describe, expect, it } from "vitest";
import { collectGlobalOptions, resolvePluginOrder } from "./plugin-loader.js";
import type { LionDenPlugin } from "./types.js";
import { ArgumentType } from "./types.js";

function plugin(id: string, opts?: Partial<LionDenPlugin>): LionDenPlugin {
  return { id, ...opts };
}

describe("resolvePluginOrder", () => {
  it("returns empty for empty input", () => {
    expect(resolvePluginOrder([])).toEqual([]);
  });

  it("returns single plugin", () => {
    const p = plugin("a");
    expect(resolvePluginOrder([p])).toEqual([p]);
  });

  it("respects dependency ordering", () => {
    const a = plugin("a");
    const b = plugin("b", { dependencies: [a] });
    const result = resolvePluginOrder([b, a]);
    const ids = result.map((p) => p.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
  });

  it("pulls in transitive dependencies", () => {
    const a = plugin("a");
    const b = plugin("b", { dependencies: [a] });
    const c = plugin("c", { dependencies: [b] });
    // User only provides c — a and b are pulled in
    const result = resolvePluginOrder([c]);
    expect(result.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("detects circular dependencies", () => {
    const a: LionDenPlugin = { id: "a" };
    const b: LionDenPlugin = { id: "b", dependencies: [a] };
    // Create circular ref
    (a as unknown as { dependencies: LionDenPlugin[] }).dependencies = [b];

    expect(() => resolvePluginOrder([a, b])).toThrow(/Circular plugin dependency/);
  });

  it("detects duplicate plugin IDs", () => {
    const a1 = plugin("a");
    const a2 = plugin("a");
    expect(() => resolvePluginOrder([a1, a2])).toThrow(/Duplicate plugin ID "a"/);
  });

  it("includes conditional dependencies that the user listed", () => {
    const optional = plugin("optional");
    const a = plugin("a", { conditionalDependencies: [optional] });
    const result = resolvePluginOrder([a, optional]);
    const ids = result.map((p) => p.id);
    expect(ids).toContain("optional");
    expect(ids.indexOf("optional")).toBeLessThan(ids.indexOf("a"));
  });

  it("excludes conditional dependencies not in user list", () => {
    const optional = plugin("optional");
    const a = plugin("a", { conditionalDependencies: [optional] });
    const result = resolvePluginOrder([a]);
    expect(result.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("collectGlobalOptions", () => {
  it("collects options from plugins", () => {
    const a = plugin("a", {
      globalOptions: [
        {
          name: "verbose",
          description: "Verbose output",
          type: ArgumentType.BOOLEAN,
        },
      ],
    });
    const result = collectGlobalOptions([a]);
    expect(result.has("verbose")).toBe(true);
    expect(result.get("verbose")!.pluginId).toBe("a");
  });

  it("detects name collisions", () => {
    const a = plugin("a", {
      globalOptions: [{ name: "opt", description: "", type: ArgumentType.STRING }],
    });
    const b = plugin("b", {
      globalOptions: [{ name: "opt", description: "", type: ArgumentType.STRING }],
    });
    expect(() => collectGlobalOptions([a, b])).toThrow(/Global option "--opt" registered by both/);
  });
});
