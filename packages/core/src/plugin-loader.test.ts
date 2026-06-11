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

  it("preserves user order for unrelated root plugins", () => {
    const a = plugin("a");
    const b = plugin("b");
    expect(resolvePluginOrder([a, b])).toEqual([a, b]);
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

  it("injects transitive dependencies before dependents while keeping unrelated roots ordered", () => {
    const root = plugin("root");
    const a = plugin("a");
    const b = plugin("b", { dependencies: [a] });
    const c = plugin("c", { dependencies: [b] });
    const result = resolvePluginOrder([root, c]);
    expect(result.map((p) => p.id)).toEqual(["root", "a", "b", "c"]);
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
});

describe("collectGlobalOptions", () => {
  it("collects options from plugins", () => {
    const a = plugin("a", {
      globalOptions: [
        {
          name: "prove",
          description: "Enable proofs",
          type: ArgumentType.BOOLEAN,
        },
      ],
    });
    const result = collectGlobalOptions([a]);
    expect(result.has("prove")).toBe(true);
    expect(result.get("prove")!.pluginId).toBe("a");
  });

  it.each([
    "verbose",
    "network",
    "config",
    "help",
    "version",
  ])("rejects built-in global option name %s", (name) => {
    const a = plugin("a", {
      globalOptions: [{ name, description: "", type: ArgumentType.STRING }],
    });
    expect(() => collectGlobalOptions([a])).toThrow(
      new RegExp(
        `Global option "--${name}" registered by "a" conflicts with built-in global option "--${name}"`,
      ),
    );
  });

  it.each(["h", "v"])("rejects built-in global option alias %s", (name) => {
    const a = plugin("a", {
      globalOptions: [{ name, description: "", type: ArgumentType.BOOLEAN }],
    });
    expect(() => collectGlobalOptions([a])).toThrow(
      new RegExp(
        `Global option "--${name}" registered by "a" conflicts with built-in global option "--${name}"`,
      ),
    );
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

  it("detects collisions between camelCase and kebab-case public names", () => {
    const a = plugin("a", {
      globalOptions: [{ name: "fooBar", description: "", type: ArgumentType.STRING }],
    });
    const b = plugin("b", {
      globalOptions: [{ name: "foo-bar", description: "", type: ArgumentType.STRING }],
    });
    expect(() => collectGlobalOptions([a, b])).toThrow(
      /Global option "--foo-bar" registered by both "a" and "b"/,
    );
  });
});
