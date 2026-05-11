import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { NetworkManager } from "@lionden/network";
import { createMockConnection } from "@lionden/test-internals";

vi.mock("@lionden/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/core")>();
  return {
    ...original,
    preflightLeo: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock devnode-lifecycle to avoid spawning real processes
vi.mock("./devnode-lifecycle.js", () => ({
  startDevnode: vi.fn().mockResolvedValue({
    manager: { stop: vi.fn() },
    endpoint: "http://127.0.0.1:3030",
  }),
  stopDevnode: vi.fn().mockResolvedValue(undefined),
}));

// Mock lre-factory so tests that omit lre don't attempt config discovery
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
import { preflightLeo } from "@lionden/core";

function mockLre(): LionDenRuntimeEnvironment {
  const connection = createMockConnection({
    execute: vi.fn().mockResolvedValue({ outputs: ["1u32"], txId: "at1exec" }),
  });
  const manager: NetworkManager = {
    connect: vi.fn().mockResolvedValue(connection),
    getConnection: vi.fn().mockReturnValue(connection),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
    getAccounts: vi.fn().mockReturnValue([]),
    getNamedAccounts: vi.fn().mockReturnValue({}),
    execute: vi.fn(),
    getMappingValue: vi.fn(),
    waitForConfirmation: vi.fn(),
  };

  return {
    config: {
      leoVersion: "4.0.0",
      skipLeoVersionCheck: false,
      leoBinary: "leo",
      defaultNetwork: "devnode",
      paths: {
        root: "/tmp/test",
        programs: "/tmp/test/programs",
        artifacts: "/tmp/test/artifacts",
        typechain: "/tmp/test/typechain",
        cache: "/tmp/test/artifacts/.cache",
        deployments: "/tmp/test/deployments",
      },
      networks: {
        devnode: {
          type: "devnode" as const,
          socketAddr: "127.0.0.1:3030",
          autoBlock: true,
          verbosity: 0,
          accounts: [],
          network: "testnet" as const,
          ephemeral: true,
        },
      },
      compiler: { enableDce: false, conditionalBlockMaxDepth: 10, buildTests: false, extraFlags: [] },
      codegen: { enabled: true, outDir: "typechain", dynamicRecords: {} },
      testing: { framework: "vitest" as const, timeout: 120_000, autoStartDevnode: true },
      deploy: {
        defaultPriorityFee: 0,
        privateFee: false,
        confirmTransactions: true,
        confirmationTimeout: 60_000,
        deploymentsDir: "deployments",
        skipDeployed: true,
        autoExport: false,
      },
      namedAccounts: {},
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
    namedAccounts: {},
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

  describe("setup with explicit lre", () => {
    it("creates a test context with connection and accounts", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre });

      expect(ctx.lre).toBe(lre);
      expect(ctx.accounts).toHaveLength(4);
      expect(ctx.connection).toBeDefined();
      expect(ctx.connection.type).toBe("devnode");
    });

    it("connects to the default network", async () => {
      const lre = mockLre();
      await setup({ lre });

      const manager = lre.network as NetworkManager;
      expect(manager.connect).toHaveBeenCalledWith("devnode");
    });

    it("connects to specified network when provided", async () => {
      const lre = mockLre();
      await setup({ lre, network: "testnet" });

      const manager = lre.network as NetworkManager;
      expect(manager.connect).toHaveBeenCalledWith("testnet");
    });

    it("creates a named account accessor for the connected network", async () => {
      const lre = mockLre();
      Object.defineProperty(lre, "namedAccounts", {
        value: {
          treasury: {
            type: "address-only",
            name: "treasury",
            address: "aleo1treasury",
          },
        },
      });

      const ctx = await setup({ lre, network: "testnet" });

      expect(ctx.named.address("treasury").address).toBe("aleo1treasury");
      expect(() => ctx.named.address("missing")).toThrow(
        [
          `Named accounts contract failed for network "testnet":`,
          `  - "missing" is not configured`,
        ].join("\n"),
      );
    });

    it("starts devnode by default", async () => {
      const lre = mockLre();
      await setup({ lre });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(preflightLeo).toHaveBeenCalledWith(lre.config);
      expect(startDevnode).toHaveBeenCalledOnce();
    });

    it("skips devnode when skipDevnode is true", async () => {
      const lre = mockLre();
      await setup({ lre, skipDevnode: true });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(preflightLeo).not.toHaveBeenCalled();
      expect(startDevnode).not.toHaveBeenCalled();
    });

    it("skips devnode when autoStartDevnode config is false", async () => {
      const lre = mockLre();
      Object.defineProperty(lre.config, "testing", {
        value: { framework: "vitest" as const, timeout: 120_000, autoStartDevnode: false },
        writable: true,
      });

      await setup({ lre });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(preflightLeo).not.toHaveBeenCalled();
      expect(startDevnode).not.toHaveBeenCalled();
    });
  });

  describe("setup without lre (auto-discovery)", () => {
    it("calls createTestLre when lre is omitted", async () => {
      const lre = mockLre();
      const lreFactory = await import("./lre-factory.js");
      (lreFactory as unknown as { __setMockLre: (lre: unknown) => void }).__setMockLre(lre);

      const ctx = await setup();

      expect(lreFactory.createTestLre).toHaveBeenCalledOnce();
      expect(ctx.lre).toBe(lre);
    });
  });

  describe("autoBlock config passthrough", () => {
    it("does not override config autoBlock when caller omits it", async () => {
      const lre = mockLre();
      await setup({ lre });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      // Should be called without autoBlock override (second arg undefined or without autoBlock)
      expect(startDevnode).toHaveBeenCalledWith(
        lre.config,
        undefined,
      );
    });

    it("passes explicit autoBlock override when caller sets it", async () => {
      const lre = mockLre();
      await setup({ lre, autoBlock: false });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(startDevnode).toHaveBeenCalledWith(
        lre.config,
        { autoBlock: false },
      );
    });
  });

  describe("ctx.deploy", () => {
    it("delegates to deploy task", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      const result = await ctx.deploy("hello");

      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "hello",
        network: "devnode",
        priorityFee: undefined,
        skipConfirm: undefined,
        noCompile: undefined,
      });
      expect(result.programId).toBe("hello.aleo");
      expect(result.txId).toBe("at1deploy");
    });

    it("passes deploy options", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.deploy("token", { priorityFee: 1000, skipConfirm: true });

      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "token",
        network: "devnode",
        priorityFee: 1000,
        skipConfirm: true,
        noCompile: undefined,
      });
    });
  });

  describe("ctx.execute", () => {
    it("defaults to onchain mode with prove=false", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", ["1u32", "2u32"]);

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "main", ["1u32", "2u32"], { mode: "onchain", fee: undefined, prove: false },
      );
    });

    it("passes prove=true when LIONDEN_PROVE is set", async () => {
      process.env["LIONDEN_PROVE"] = "true";
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", ["1u32"]);

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "main", ["1u32"], { mode: "onchain", fee: undefined, prove: true },
      );
    });

    it("explicit mode overrides default", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", [], { mode: "local" });

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "main", [], { mode: "local", fee: undefined, prove: false },
      );
    });

    it("passes execution options", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", [], { mode: "onchain", fee: 500 });

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "main", [], { mode: "onchain", fee: 500, prove: false },
      );
    });
  });

  describe("ctx.raw.execute", () => {
    it("exposes the explicit raw execution escape hatch", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.raw.execute("hello.aleo", "post_upgrade", ["1u32"], { mode: "local" });

      expect(ctx.connection.execute).toHaveBeenCalledWith(
        "hello.aleo", "post_upgrade", ["1u32"], { mode: "local", fee: undefined, prove: false },
      );
    });

    it("uses the same implementation as the compatibility ctx.execute helper", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      expect(ctx.raw.execute).toBe(ctx.execute);
    });
  });

  describe("ctx.advanceBlocks", () => {
    it("delegates to connection.advanceBlocks on devnode", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.advanceBlocks(5);

      expect(ctx.connection.advanceBlocks).toHaveBeenCalledWith(5);
    });
  });

  describe("ctx.teardown", () => {
    it("disconnects and stops devnode", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre });

      await ctx.teardown();

      const manager = lre.network as NetworkManager;
      expect(manager.disconnectAll).toHaveBeenCalledOnce();

      const { stopDevnode } = await import("./devnode-lifecycle.js");
      expect(stopDevnode).toHaveBeenCalledOnce();
    });

    it("skips stopDevnode when devnode was not started", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.teardown();

      const { stopDevnode } = await import("./devnode-lifecycle.js");
      expect(stopDevnode).not.toHaveBeenCalled();
    });
  });
});
