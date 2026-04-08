import { describe, it, expect } from "vitest";
import pluginNetwork from "./index.js";
import { createLre } from "@lionden/core";
import type { LionDenResolvedConfig } from "@lionden/config";
import type { NetworkManager } from "@lionden/network";

const mockConfig: LionDenResolvedConfig = {
  leoVersion: "4.0.0",
  paths: {
    root: "/tmp",
    programs: "/tmp/programs",
    artifacts: "/tmp/artifacts",
    typechain: "/tmp/typechain",
    cache: "/tmp/cache",
  },
  networks: {
    devnode: {
      type: "devnode",
      socketAddr: "127.0.0.1:3030",
      autoBlock: true,
      verbosity: 0,
      accounts: [],
      network: "testnet",
    },
  },
  defaultNetwork: "devnode",
  compiler: {
    enableDce: true,
    conditionalBlockMaxDepth: 10,
    buildTests: false,
    extraFlags: [],
  },
  codegen: { enabled: true, outDir: "typechain" },
  testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
  deploy: {
    defaultPriorityFee: 0,
    confirmTransactions: true,
    confirmationTimeout: 60_000,
  },
};

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
