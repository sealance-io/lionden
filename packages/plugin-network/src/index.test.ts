import { describe, it, expect } from "vitest";
import pluginNetwork from "./index.js";
import { createLre } from "@lionden/core";
import type { ConfigValidationError } from "@lionden/core";
import { createMockConfig } from "@lionden/test-internals";
import type { NetworkManager } from "@lionden/network";

const mockConfig = createMockConfig();

describe("plugin-network", () => {
  it("has correct plugin id and name", () => {
    expect(pluginNetwork.id).toBe("@lionden/plugin-network");
    expect(pluginNetwork.name).toBe("Network Plugin");
  });

  it("registers node and run tasks", () => {
    const taskIds = pluginNetwork.tasks?.map((t) => t.id) ?? [];
    expect(taskIds).toContain("node");
    expect(taskIds).toContain("run");
  });

  it("has config and network hook handlers", () => {
    expect(pluginNetwork.hookHandlers).toBeDefined();
    expect(pluginNetwork.hookHandlers!.config).toBeDefined();
    expect(pluginNetwork.hookHandlers!.network).toBeDefined();
  });

  it("provides extendLre that injects network manager", () => {
    expect(pluginNetwork.extendLre).toBeDefined();
    expect(typeof pluginNetwork.extendLre).toBe("function");
  });

  it("extendLre sets lre.network to a NetworkManager", () => {
    const lre = createLre({
      config: mockConfig,
      plugins: [pluginNetwork],
    });

    // extendLre is called during createLre
    const network = lre.network as NetworkManager;
    expect(network).not.toBeNull();
    expect(typeof network.connect).toBe("function");
    expect(typeof network.disconnectAll).toBe("function");
    expect(typeof network.getAccounts).toBe("function");
    expect(typeof network.execute).toBe("function");
    expect(typeof network.getMappingValue).toBe("function");
  });

  it("lre.network.getAccounts returns devnode accounts", () => {
    const lre = createLre({
      config: mockConfig,
      plugins: [pluginNetwork],
    });

    const network = lre.network as NetworkManager;
    const accounts = network.getAccounts();
    expect(accounts).toHaveLength(4);
    expect(accounts[0]!.name).toBe("account-0");
  });

  it("node task has port option and manualBlocks flag", () => {
    const nodeTask = pluginNetwork.tasks?.find((t) => t.id === "node");
    expect(nodeTask).toBeDefined();

    const optionNames = nodeTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("port");
    expect(optionNames).toContain("network");

    const flagNames = nodeTask!.flags?.map((f) => f.name) ?? [];
    expect(flagNames).toContain("manualBlocks");
  });

  it("run task has script positional argument and network option", () => {
    const runTask = pluginNetwork.tasks?.find((t) => t.id === "run");
    expect(runTask).toBeDefined();

    const positionalNames =
      runTask!.positionalArguments?.map((p) => p.name) ?? [];
    expect(positionalNames).toContain("script");

    const optionNames = runTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("network");
  });
});

describe("validateResolvedConfig — standalone/storage rules", () => {
  const validate = (network: Record<string, unknown>): ConfigValidationError[] => {
    const config = {
      defaultNetwork: "devnode",
      networks: { devnode: { type: "devnode", ...network } },
    } as never;
    const configHook = pluginNetwork.hookHandlers!.config as {
      validateResolvedConfig: (c: never) => ConfigValidationError[];
    };
    return configHook.validateResolvedConfig(config);
  };

  it("rejects explicit standalone with non-testnet network", () => {
    const errors = validate({ provider: "standalone", network: "mainnet" });
    expect(errors.some((e) => e.path === "networks.devnode.network")).toBe(true);
  });

  it("rejects explicit standalone with consensusHeights", () => {
    const errors = validate({
      provider: "standalone",
      network: "testnet",
      consensusHeights: "0,1,2",
    });
    expect(errors.some((e) => e.path === "networks.devnode.consensusHeights")).toBe(true);
  });

  it("does not flag auto-detect (provider undefined) with non-testnet here", () => {
    const errors = validate({ network: "mainnet" });
    expect(errors.some((e) => e.path === "networks.devnode.network")).toBe(false);
  });

  it("rejects clearStorageOnStart without storagePath", () => {
    const errors = validate({ clearStorageOnStart: true });
    expect(errors.some((e) => e.path === "networks.devnode.clearStorageOnStart")).toBe(true);
  });

  it("accepts a valid standalone testnet config with storage", () => {
    const errors = validate({
      provider: "standalone",
      network: "testnet",
      storagePath: "/tmp/l",
      clearStorageOnStart: true,
    });
    expect(errors).toHaveLength(0);
  });
});

describe("node task has persist/clearStorage options", () => {
  it("exposes --persist and --clear-storage", () => {
    const nodeTask = pluginNetwork.tasks?.find((t) => t.id === "node");
    const optionNames = nodeTask!.options?.map((o) => o.name) ?? [];
    const flagNames = nodeTask!.flags?.map((f) => f.name) ?? [];
    expect(optionNames).toContain("persist");
    expect(flagNames).toContain("clearStorage");
  });
});

describe("extendLre lifecycle", () => {
  it("plugins without extendLre are handled correctly", () => {
    const simplePlugin = {
      id: "simple",
      tasks: [],
    };

    const lre = createLre({
      config: mockConfig,
      plugins: [simplePlugin],
    });

    expect(lre.network).toBeNull();
  });

  it("extendLre is called in plugin order", () => {
    const order: string[] = [];

    const plugin1 = {
      id: "first",
      extendLre: () => { order.push("first"); },
    };

    const plugin2 = {
      id: "second",
      extendLre: () => { order.push("second"); },
    };

    createLre({
      config: mockConfig,
      plugins: [plugin1, plugin2],
    });

    expect(order).toEqual(["first", "second"]);
  });
});
