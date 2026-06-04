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

  describe("parallel", () => {
    it("calls all handlers concurrently", async () => {
      const called: string[] = [];
      const a = pluginWithConfigHooks("a", {
        validateResolvedConfig: async () => {
          called.push("a");
          return [];
        },
      });
      const b = pluginWithConfigHooks("b", {
        validateResolvedConfig: async () => {
          called.push("b");
          return [];
        },
      });

      const dispatcher = new HookDispatcherImpl();
      dispatcher.registerPlugins([a, b]);
      await dispatcher.parallel("config", "validateResolvedConfig", {});
      expect(called).toContain("a");
      expect(called).toContain("b");
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
