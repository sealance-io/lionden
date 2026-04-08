import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { NetworkConnection, NetworkManager } from "@lionden/network";

// Mock devnode-lifecycle to avoid spawning real processes
vi.mock("./devnode-lifecycle.js", () => ({
  startDevnode: vi.fn().mockResolvedValue({
    manager: { stop: vi.fn() },
    endpoint: "http://127.0.0.1:3030",
  }),
  stopDevnode: vi.fn().mockResolvedValue(undefined),
}));

// Mock lre-factory so tests that omit hre don't attempt config discovery
vi.mock("./lre-factory.js", async () => {
  // Will be set per-test via the mockCreateTestLre helper
  let mockLre: LionDenRuntimeEnvironment | null = null;
  return {
    createTestLre: vi.fn(async () => {
      if (!mockLre) throw new Error("createTestLre mock not configured");
      return mockLre;
    }),
    resetTestLre: vi.fn(),
    __setMockLre: (lre: LionDenRuntimeEnvironment) => { mockLre = lre; },
  };
});

import { setup } from "./test-context.js";

function mockConnection(): NetworkConnection {
  return {
    type: "devnode",
    name: "devnode",
    endpoint: "http://127.0.0.1:3030",
    networkId: "testnet",
    getBalance: vi.fn().mockResolvedValue(1000n),
    getMappingValue: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ outputs: ["1u32"], txId: "at1exec" }),
    waitForConfirmation: vi.fn().mockResolvedValue({
      txId: "at1test", blockHeight: 10, status: "accepted",
    }),
    getBlockHeight: vi.fn().mockResolvedValue(100),
    advanceBlocks: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } as unknown as NetworkConnection;
}

function mockHre(): LionDenRuntimeEnvironment {
  const connection = mockConnection();
  const manager: NetworkManager = {
    connect: vi.fn().mockResolvedValue(connection),
    getConnection: vi.fn().mockReturnValue(connection),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
    getAccounts: vi.fn().mockReturnValue([]),
    execute: vi.fn(),
    getMappingValue: vi.fn(),
  };

  return {
    config: {
      leoVersion: "4.0.0",
      defaultNetwork: "devnode",
      paths: {
        root: "/tmp/test",
        programs: "/tmp/test/programs",
        artifacts: "/tmp/test/artifacts",
        typechain: "/tmp/test/typechain",
        cache: "/tmp/test/artifacts/.cache",
      },
      networks: {
        devnode: {
          type: "devnode" as const,
          socketAddr: "127.0.0.1:3030",
          autoBlock: true,
          verbosity: 0,
          accounts: [],
          network: "testnet" as const,
        },
      },
      compiler: { enableDce: false, conditionalBlockMaxDepth: 10, buildTests: false, extraFlags: [] },
      codegen: { enabled: true, outDir: "typechain" },
      testing: { framework: "vitest" as const, timeout: 120_000, autoStartDevnode: true },
      deploy: { defaultPriorityFee: 0, confirmTransactions: true, confirmationTimeout: 60_000 },
    },
    network: manager,
    tasks: {
      run: vi.fn().mockResolvedValue([{ programId: "hello.aleo", txId: "at1deploy" }]),
      has: vi.fn().mockReturnValue(true),
      getTaskIds: vi.fn().mockReturnValue(["compile", "deploy"]),
    },
    hooks: {
      serial: vi.fn(),
      waterfall: vi.fn(),
      parallel: vi.fn(),
    },
    artifacts: {
      getAbi: vi.fn(),
      getAleoSource: vi.fn(),
      getProgramIds: vi.fn().mockReturnValue([]),
      setAbi: vi.fn(),
      setAleoSource: vi.fn(),
    },
    plugins: [],
    globalOptions: {},
  } as unknown as LionDenRuntimeEnvironment;
}

describe("test-context", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["LIONDEN_PROVE"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("setup with explicit hre", () => {
    it("creates a test context with connection and accounts", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre });

      expect(ctx.hre).toBe(hre);
      expect(ctx.accounts).toHaveLength(4);
      expect(ctx.connection).toBeDefined();
      expect(ctx.connection.type).toBe("devnode");
    });

    it("connects to the default network", async () => {
      const hre = mockHre();
      await setup({ hre });

      const manager = hre.network as NetworkManager;
      expect(manager.connect).toHaveBeenCalledWith("devnode");
    });

    it("connects to specified network when provided", async () => {
      const hre = mockHre();
      await setup({ hre, network: "testnet" });

      const manager = hre.network as NetworkManager;
      expect(manager.connect).toHaveBeenCalledWith("testnet");
    });

    it("starts devnode by default", async () => {
      const hre = mockHre();
      await setup({ hre });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(startDevnode).toHaveBeenCalledOnce();
    });

    it("skips devnode when skipDevnode is true", async () => {
      const hre = mockHre();
      await setup({ hre, skipDevnode: true });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(startDevnode).not.toHaveBeenCalled();
    });

    it("skips devnode when autoStartDevnode config is false", async () => {
      const hre = mockHre();
      Object.defineProperty(hre.config, "testing", {
        value: { framework: "vitest" as const, timeout: 120_000, autoStartDevnode: false },
        writable: true,
      });

      await setup({ hre });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(startDevnode).not.toHaveBeenCalled();
    });
  });

  describe("setup without hre (auto-discovery)", () => {
    it("calls createTestLre when hre is omitted", async () => {
      const hre = mockHre();
      const lreFactory = await import("./lre-factory.js");
      (lreFactory as unknown as { __setMockLre: (lre: unknown) => void }).__setMockLre(hre);

      const ctx = await setup();

      expect(lreFactory.createTestLre).toHaveBeenCalledOnce();
      expect(ctx.hre).toBe(hre);
    });
  });

  describe("autoBlock config passthrough", () => {
    it("does not override config autoBlock when caller omits it", async () => {
      const hre = mockHre();
      await setup({ hre });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      // Should be called without autoBlock override (second arg undefined or without autoBlock)
      expect(startDevnode).toHaveBeenCalledWith(
        hre.config,
        undefined,
      );
    });

    it("passes explicit autoBlock override when caller sets it", async () => {
      const hre = mockHre();
      await setup({ hre, autoBlock: false });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(startDevnode).toHaveBeenCalledWith(
        hre.config,
        { autoBlock: false },
      );
    });
  });

  describe("ctx.deploy", () => {
    it("delegates to deploy task", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre, skipDevnode: true });

      const result = await ctx.deploy("hello");

      expect(hre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "hello",
        priorityFee: undefined,
        skipConfirm: undefined,
      });
      expect(result.programId).toBe("hello.aleo");
      expect(result.txId).toBe("at1deploy");
    });

    it("passes deploy options", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre, skipDevnode: true });

      await ctx.deploy("token", { priorityFee: 1000, skipConfirm: true });

      expect(hre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "token",
        priorityFee: 1000,
        skipConfirm: true,
      });
    });
  });

  describe("ctx.execute", () => {
    it("defaults to onchain mode with prove=false", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", ["1u32", "2u32"]);

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "main", ["1u32", "2u32"], { mode: "onchain", fee: undefined, prove: false },
      );
    });

    it("passes prove=true when LIONDEN_PROVE is set", async () => {
      process.env["LIONDEN_PROVE"] = "true";
      const hre = mockHre();
      const ctx = await setup({ hre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", ["1u32"]);

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "main", ["1u32"], { mode: "onchain", fee: undefined, prove: true },
      );
    });

    it("explicit mode overrides default", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", [], { mode: "local" });

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "main", [], { mode: "local", fee: undefined, prove: false },
      );
    });

    it("passes execution options", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", [], { mode: "onchain", fee: 500 });

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "main", [], { mode: "onchain", fee: 500, prove: false },
      );
    });
  });

  describe("ctx.advanceBlocks", () => {
    it("delegates to connection.advanceBlocks on devnode", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre, skipDevnode: true });

      await ctx.advanceBlocks(5);

      expect(ctx.connection.advanceBlocks).toHaveBeenCalledWith(5);
    });
  });

  describe("ctx.teardown", () => {
    it("disconnects and stops devnode", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre });

      await ctx.teardown();

      const manager = hre.network as NetworkManager;
      expect(manager.disconnectAll).toHaveBeenCalledOnce();

      const { stopDevnode } = await import("./devnode-lifecycle.js");
      expect(stopDevnode).toHaveBeenCalledOnce();
    });

    it("skips stopDevnode when devnode was not started", async () => {
      const hre = mockHre();
      const ctx = await setup({ hre, skipDevnode: true });

      await ctx.teardown();

      const { stopDevnode } = await import("./devnode-lifecycle.js");
      expect(stopDevnode).not.toHaveBeenCalled();
    });
  });
});
