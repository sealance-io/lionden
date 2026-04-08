import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LionDenResolvedConfig } from "@lionden/config";

// Mock DevnodeManager before importing the module under test
vi.mock("@lionden/network", () => {
  const DevnodeManager = vi.fn().mockImplementation(function () {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.endpoint = "http://127.0.0.1:3030";
    this.isRunning = vi.fn().mockReturnValue(true);
    return this;
  });

  return { DevnodeManager };
});

import { startDevnode, stopDevnode } from "./devnode-lifecycle.js";

function makeConfig(networks: Record<string, unknown> = {}): LionDenResolvedConfig {
  return {
    leoVersion: "4.0.0",
    defaultNetwork: "devnode",
    paths: {
      root: "/tmp/test",
      programs: "/tmp/test/programs",
      artifacts: "/tmp/test/artifacts",
      typechain: "/tmp/test/typechain",
      cache: "/tmp/test/artifacts/.cache",
    },
    networks: networks as LionDenResolvedConfig["networks"],
    compiler: { enableDce: false, conditionalBlockMaxDepth: 10, buildTests: false, extraFlags: [] },
    codegen: { enabled: true, outDir: "typechain" },
    testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
    deploy: { defaultPriorityFee: 0, confirmTransactions: true, confirmationTimeout: 60_000 },
  };
}

describe("devnode-lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("startDevnode", () => {
    it("starts a devnode and returns managed instance", async () => {
      const result = await startDevnode();

      expect(result.endpoint).toBe("http://127.0.0.1:3030");
      expect(result.manager).toBeDefined();
      expect(result.manager.start).toHaveBeenCalledOnce();
    });

    it("passes config-derived options when config provided", async () => {
      const config = makeConfig({
        devnode: { type: "devnode", autoBlock: false, network: "testnet" },
      });

      const result = await startDevnode(config);

      expect(result.manager.start).toHaveBeenCalledWith(
        expect.objectContaining({
          autoBlock: false,
          network: "testnet",
        }),
      );
    });

    it("applies override options", async () => {
      const result = await startDevnode(undefined, {
        socketAddr: "127.0.0.1:4040",
        autoBlock: false,
      });

      expect(result.manager.start).toHaveBeenCalledWith(
        expect.objectContaining({
          socketAddr: "127.0.0.1:4040",
          autoBlock: false,
        }),
      );
    });

    it("defaults to autoBlock=true when no config", async () => {
      await startDevnode();

      const { DevnodeManager } = await import("@lionden/network");
      const instance = (DevnodeManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value;
      expect(instance.start).toHaveBeenCalledWith(
        expect.objectContaining({ autoBlock: true }),
      );
    });
  });

  describe("stopDevnode", () => {
    it("stops the devnode manager", async () => {
      const managed = await startDevnode();
      await stopDevnode(managed);

      expect(managed.manager.stop).toHaveBeenCalledOnce();
    });
  });
});
