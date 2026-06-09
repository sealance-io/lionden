import type { LionDenResolvedConfig } from "@lionden/config";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  devnodeStart: vi.fn(),
  devnodeStop: vi.fn(),
  resolveDevnodeBackend: vi.fn(),
  preflightDevnode: vi.fn(),
}));

vi.mock("@lionden/network", () => ({
  NetworkManagerImpl: vi.fn(),
  DevnodeManager: vi.fn().mockImplementation(function DevnodeManager() {
    return {
      endpoint: "http://127.0.0.1:3030",
      start: mocks.devnodeStart,
      stop: mocks.devnodeStop,
    };
  }),
  resolveDevnodeBackend: mocks.resolveDevnodeBackend,
  preflightDevnode: mocks.preflightDevnode,
}));

import pluginNetwork from "./index.js";

function makeConfig(): LionDenResolvedConfig {
  return {
    leoVersion: "4.0.0",
    skipLeoVersionCheck: false,
    leoBinary: "/tmp/leo",
    paths: {
      root: "/tmp/test",
      programs: "/tmp/test/programs",
      artifacts: "/tmp/test/artifacts",
      typechain: "/tmp/test/typechain",
      cache: "/tmp/test/cache",
      deployments: "/tmp/test/deployments",
    },
    networks: {
      devnode: {
        type: "devnode",
        socketAddr: "127.0.0.1:3030",
        autoBlock: true,
        verbosity: 0,
        accounts: [],
        network: "testnet",
        ephemeral: true,
      },
    },
    defaultNetwork: "devnode",
    compiler: {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    },
    codegen: { enabled: true, outDir: "typechain", dynamicRecords: {} },
    testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
    deploy: {
      defaultPriorityFee: 0,
      privateFee: false,
      confirmTransactions: true,
      confirmationTimeout: 60_000,
      deploymentsDir: "deployments",
      skipDeployed: true,
      autoExport: false,
    },
    sdk: { keyCache: { storage: "memory" } },
    execution: { imports: {} },
    namedAccounts: {},
  };
}

describe("node task devnode preflight", () => {
  const leoBackend = {
    provider: "leo" as const,
    command: "/tmp/leo",
    capabilities: { snapshot: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.devnodeStart.mockRejectedValue(new Error("stop after start"));
    mocks.devnodeStop.mockResolvedValue(undefined);
    mocks.resolveDevnodeBackend.mockResolvedValue(leoBackend);
    mocks.preflightDevnode.mockResolvedValue(undefined);
  });

  it("resolves the backend and preflights before starting the devnode", async () => {
    const nodeTask = pluginNetwork.tasks?.find((t) => t.id === "node");
    const lre = { config: makeConfig() } as LionDenRuntimeEnvironment;
    const processOn = vi.spyOn(process, "on").mockReturnValue(process);

    try {
      await expect(nodeTask!.action({ port: 3030, manualBlocks: false }, lre)).rejects.toThrow(
        "stop after start",
      );
    } finally {
      processOn.mockRestore();
    }

    expect(mocks.resolveDevnodeBackend).toHaveBeenCalledWith(
      expect.objectContaining({ leoBinary: "/tmp/leo", network: "testnet" }),
    );
    expect(mocks.preflightDevnode).toHaveBeenCalledWith(lre.config, leoBackend);
    expect(mocks.devnodeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        socketAddr: "127.0.0.1:3030",
        autoBlock: true,
        network: "testnet",
        provider: "leo",
        leoBinary: "/tmp/leo",
      }),
    );
    expect(mocks.devnodeStart.mock.calls[0]![0]).not.toHaveProperty("leoVersion");
  });

  it("requests persistence when --persist is passed and forwards storagePath", async () => {
    mocks.resolveDevnodeBackend.mockResolvedValue({
      provider: "standalone",
      command: "aleo-devnode",
      capabilities: { snapshot: true },
    });
    const nodeTask = pluginNetwork.tasks?.find((t) => t.id === "node");
    const lre = { config: makeConfig() } as LionDenRuntimeEnvironment;
    const processOn = vi.spyOn(process, "on").mockReturnValue(process);

    try {
      await expect(
        nodeTask!.action({ port: 3030, manualBlocks: false, persist: "/tmp/ledger" }, lre),
      ).rejects.toThrow("stop after start");
    } finally {
      processOn.mockRestore();
    }

    expect(mocks.resolveDevnodeBackend).toHaveBeenCalledWith(
      expect.objectContaining({ requiresPersistence: true }),
    );
    expect(mocks.devnodeStart).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "standalone", storagePath: "/tmp/ledger" }),
    );
  });

  it("rejects --clear-storage without --persist", async () => {
    const nodeTask = pluginNetwork.tasks?.find((t) => t.id === "node");
    const lre = { config: makeConfig() } as LionDenRuntimeEnvironment;
    await expect(
      nodeTask!.action({ port: 3030, manualBlocks: false, clearStorage: true }, lre),
    ).rejects.toThrow(/--clear-storage requires --persist/);
  });
});
