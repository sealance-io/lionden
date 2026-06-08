import { describe, expect, it, vi } from "vitest";
import { HookDispatcherImpl } from "./hook-system.js";
import type { ConfigHookHandlers, LionDenPlugin } from "./types.js";

function pluginWithConfigHooks(id: string, handlers: ConfigHookHandlers): LionDenPlugin {
  return {
    id,
    hookHandlers: { config: handlers },
  };
}

describe("HookDispatcherImpl", () => {
  describe("serial", () => {
    it("calls handlers in plugin order", async () => {
      const order: string[] = [];
      const a = pluginWithConfigHooks("a", {
        extendUserConfig: async (config) => {
          order.push("a");
          return config;
        },
      });
      const b = pluginWithConfigHooks("b", {
        extendUserConfig: async (config) => {
          order.push("b");
          return config;
        },
      });

      const dispatcher = new HookDispatcherImpl();
      dispatcher.registerPlugins([a, b]);
      await dispatcher.serial("config", "extendUserConfig", {});
      expect(order).toEqual(["a", "b"]);
    });
  });

  describe("waterfall", () => {
    it("chains handler results", async () => {
      const a = pluginWithConfigHooks("a", {
        extendUserConfig: (config) => ({
          ...config,
          leoVersion: "4.0.0",
        }),
      });
      const b = pluginWithConfigHooks("b", {
        extendUserConfig: (config) => ({
          ...config,
          defaultNetwork: "devnode",
        }),
      });

      const dispatcher = new HookDispatcherImpl();
      dispatcher.registerPlugins([a, b]);
      const result = await dispatcher.waterfall("config", "extendUserConfig", {});
      expect(result).toEqual({
        leoVersion: "4.0.0",
        defaultNetwork: "devnode",
      });
    });
  });

  describe("collect", () => {
    it("gathers handler return values in plugin order", async () => {
      const a = pluginWithConfigHooks("a", {
        validateUserConfig: () => [{ path: "a", message: "from a" }],
      });
      const b = pluginWithConfigHooks("b", {
        validateUserConfig: () => [{ path: "b", message: "from b" }],
      });

      const dispatcher = new HookDispatcherImpl();
      dispatcher.registerPlugins([a, b]);
      const results = await dispatcher.collect("config", "validateUserConfig", {});
      expect(results).toEqual([[{ path: "a", message: "from a" }], [{ path: "b", message: "from b" }]]);
      expect(results.flat()).toEqual([
        { path: "a", message: "from a" },
        { path: "b", message: "from b" },
      ]);
    });

    it("forwards extra args to every handler", async () => {
      const seen: unknown[] = [];
      const a = pluginWithConfigHooks("a", {
        resolveConfig: (config, resolveVar) => {
          seen.push(resolveVar);
          return { leoVersion: "4.0.0" };
        },
      });

      const dispatcher = new HookDispatcherImpl();
      dispatcher.registerPlugins([a]);
      const resolveVar = async () => "resolved";
      const results = await dispatcher.collect("config", "resolveConfig", {}, resolveVar);
      expect(results).toEqual([{ leoVersion: "4.0.0" }]);
      expect(seen).toEqual([resolveVar]);
    });

    it("returns an empty array for a category with no handlers", async () => {
      const dispatcher = new HookDispatcherImpl();
      const results = await dispatcher.collect("config", "validateUserConfig", {});
      expect(results).toEqual([]);
    });

    it("shares lazy category resolution across concurrent collect calls", async () => {
      let releaseFactory!: () => void;
      const factoryGate = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      const handler = vi.fn(() => [] as never[]);
      const factory = vi.fn(async () => {
        await factoryGate;
        return { validateUserConfig: handler };
      });

      const plugin: LionDenPlugin = {
        id: "lazy",
        hookHandlers: {
          config: factory as unknown as () => Promise<ConfigHookHandlers>,
        },
      };

      const dispatcher = new HookDispatcherImpl();
      dispatcher.registerPlugins([plugin]);

      const first = dispatcher.collect("config", "validateUserConfig", {});
      const second = dispatcher.collect("config", "validateUserConfig", {});

      expect(factory).toHaveBeenCalledOnce();

      releaseFactory();
      await Promise.all([first, second]);

      expect(factory).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("lazy loading", () => {
    it("lazy-loads hook handlers on first invocation", async () => {
      const factory = vi.fn(async () => ({
        extendUserConfig: (config: unknown) => config,
      }));

      const plugin: LionDenPlugin = {
        id: "lazy",
        hookHandlers: {
          config: factory as unknown as () => Promise<ConfigHookHandlers>,
        },
      };

      const dispatcher = new HookDispatcherImpl();
      dispatcher.registerPlugins([plugin]);

      // Factory not called yet
      expect(factory).not.toHaveBeenCalled();

      // First invocation triggers lazy load
      await dispatcher.serial("config", "extendUserConfig", {});
      expect(factory).toHaveBeenCalledOnce();

      // Second invocation does not re-invoke factory
      await dispatcher.serial("config", "extendUserConfig", {});
      expect(factory).toHaveBeenCalledOnce();
    });

    it("shares lazy category resolution across concurrent dispatches", async () => {
      let releaseFactory!: () => void;
      const factoryGate = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      const handler = vi.fn((config: unknown) => config);
      const factory = vi.fn(async () => {
        await factoryGate;
        return {
          extendUserConfig: handler,
        };
      });

      const plugin: LionDenPlugin = {
        id: "lazy",
        hookHandlers: {
          config: factory as unknown as () => Promise<ConfigHookHandlers>,
        },
      };

      const dispatcher = new HookDispatcherImpl();
      dispatcher.registerPlugins([plugin]);

      const first = dispatcher.serial("config", "extendUserConfig", {});
      const second = dispatcher.serial("config", "extendUserConfig", {});

      expect(factory).toHaveBeenCalledOnce();

      releaseFactory();
      await Promise.all([first, second]);

      expect(factory).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores hooks with no handlers for the given name", async () => {
    const a = pluginWithConfigHooks("a", {
      // Only provides extendUserConfig, not validateUserConfig
      extendUserConfig: (config) => config,
    });

    const dispatcher = new HookDispatcherImpl();
    dispatcher.registerPlugins([a]);

    // Should not throw
    await dispatcher.serial("config", "validateUserConfig", {});
  });
});
