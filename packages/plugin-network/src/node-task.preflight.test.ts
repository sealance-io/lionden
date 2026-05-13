import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { LionDenResolvedConfig } from "@lionden/config";

const mocks = vi.hoisted(() => ({
  devnodeStart: vi.fn(),
  devnodeStop: vi.fn(),
}));

vi.mock("@lionden/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/core")>();
  return {
    ...original,
    preflightLeo: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@lionden/network", () => ({
  NetworkManagerImpl: vi.fn(),
  DevnodeManager: vi.fn().mockImplementation(function DevnodeManager() {
    return {
      endpoint: "http://127.0.0.1:3030",
      start: mocks.devnodeStart,
      stop: mocks.devnodeStop,
    };
  }),
}));

import { preflightLeo } from "@lionden/core";
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

describe("node task Leo preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.devnodeStart.mockRejectedValue(new Error("stop after start"));
    mocks.devnodeStop.mockResolvedValue(undefined);
  });

  it("preflights the resolved Leo binary before starting the devnode", async () => {
    const nodeTask = pluginNetwork.tasks?.find((t) => t.id === "node");
    const lre = { config: makeConfig() } as LionDenRuntimeEnvironment;
    const processOn = vi.spyOn(process, "on").mockReturnValue(process);

    try {
      await expect(
        nodeTask!.action(
          { port: 3030, manualBlocks: false, network: "testnet" },
          lre,
        ),
      ).rejects.toThrow("stop after start");
    } finally {
      processOn.mockRestore();
    }

    expect(preflightLeo).toHaveBeenCalledWith(lre.config);
    expect(mocks.devnodeStart).toHaveBeenCalledWith(
      expect.objectContaining({
        socketAddr: "127.0.0.1:3030",
        autoBlock: true,
        network: "testnet",
        leoBinary: "/tmp/leo",
      }),
    );
    expect(mocks.devnodeStart.mock.calls[0]![0]).not.toHaveProperty("leoVersion");
  });
});
