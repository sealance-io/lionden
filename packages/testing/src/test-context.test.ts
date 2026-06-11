import { existsSync } from "node:fs";
import * as path from "node:path";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import type { NetworkConnection, NetworkManager } from "@lionden/network";
import { createMockConnection } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedDeploymentRecord, DeploymentCacheAccessor } from "./deployment-cache.js";

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
    __setMockLre: (lre: LionDenRuntimeEnvironment) => {
      mockLre = lre;
    },
  };
});

import { preflightLeo } from "@lionden/core";
import { setup } from "./test-context.js";

function mockLre(
  options: { readonly connection?: NetworkConnection } = {},
): LionDenRuntimeEnvironment {
  const connection =
    options.connection ??
    createMockConnection({
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
    getTransitionOutputs: vi.fn(),
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
      compiler: {
        enableDce: false,
        conditionalBlockMaxDepth: 10,
        buildTests: false,
        extraFlags: [],
      },
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

function cachedDeployment(
  programId: string,
  options: {
    readonly status?: string;
    readonly txId?: string | null;
    readonly blockHeight?: number | null;
  } = {},
): CachedDeploymentRecord {
  return {
    status: options.status ?? "complete",
    programId,
    txId: options.txId === undefined ? "at1cached" : options.txId,
    blockHeight: options.blockHeight === undefined ? 1 : options.blockHeight,
    constructor: { type: "noupgrade" },
  };
}

function attachDeploymentCache(
  lre: LionDenRuntimeEnvironment,
  getCached: DeploymentCacheAccessor["getCached"],
): void {
  Object.defineProperty(lre, "deployments", {
    value: {
      getCached,
      invalidateSession: vi.fn(),
    } satisfies DeploymentCacheAccessor,
  });
}

describe("test-context", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["LIONDEN_PROVE"];
  });

  afterEach(() => {
    vi.useRealTimers();
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
      // Preflight now lives inside startDevnode (which resolves the backend).
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

    it("checks manual devnode reachability when autoStartDevnode is false", async () => {
      const getBlockHeight = vi.fn().mockRejectedValue(new Error("SDK init failed"));
      const connection = createMockConnection({ getBlockHeight });
      const lre = mockLre({ connection });
      Object.defineProperty(lre.config, "testing", {
        value: { framework: "vitest" as const, timeout: 120_000, autoStartDevnode: false },
        writable: true,
      });

      await expect(setup({ lre })).rejects.toThrow(
        /Devnode network "devnode" is not reachable at http:\/\/127\.0\.0\.1:3030 .*testing\.autoStartDevnode is false.*Cause:/,
      );
      expect(getBlockHeight).toHaveBeenCalledOnce();
      expect(connection.close).toHaveBeenCalledOnce();
    });

    it("checks manual devnode reachability when skipDevnode is true", async () => {
      const getBlockHeight = vi.fn().mockRejectedValue(new Error("fetch failed"));
      const connection = createMockConnection({ getBlockHeight });
      const lre = mockLre({ connection });

      await expect(setup({ lre, skipDevnode: true })).rejects.toThrow(
        /Devnode network "devnode" is not reachable at http:\/\/127\.0\.0\.1:3030 .*setup\(\{ skipDevnode: true \}\) was passed.*Cause:/,
      );
      expect(getBlockHeight).toHaveBeenCalledOnce();
      expect(connection.close).toHaveBeenCalledOnce();
    });

    it("reports both manual devnode reasons when skipDevnode and autoStartDevnode=false combine", async () => {
      const getBlockHeight = vi.fn().mockRejectedValue(new Error("node offline"));
      const connection = createMockConnection({ getBlockHeight });
      const lre = mockLre({ connection });
      Object.defineProperty(lre.config, "testing", {
        value: { framework: "vitest" as const, timeout: 120_000, autoStartDevnode: false },
        writable: true,
      });

      await expect(setup({ lre, skipDevnode: true })).rejects.toThrow(
        /setup\(\{ skipDevnode: true \}\) was passed and testing\.autoStartDevnode is false/,
      );
      expect(getBlockHeight).toHaveBeenCalledOnce();
      expect(connection.close).toHaveBeenCalledOnce();
    });

    it("continues when manual devnode reachability check succeeds", async () => {
      const getBlockHeight = vi.fn().mockResolvedValue(42);
      const connection = createMockConnection({ getBlockHeight });
      const lre = mockLre({ connection });

      const ctx = await setup({ lre, skipDevnode: true });

      expect(ctx.connection).toBe(connection);
      expect(getBlockHeight).toHaveBeenCalledOnce();
    });

    it("does not health-check HTTP connections during manual setup", async () => {
      const getBlockHeight = vi.fn().mockRejectedValue(new Error("should not run"));
      const connection = createMockConnection({
        type: "http",
        name: "testnet",
        endpoint: "https://api.explorer.provable.com/v1",
        getBlockHeight,
      });
      const lre = mockLre({ connection });

      const ctx = await setup({ lre, skipDevnode: true, network: "testnet" });

      expect(ctx.connection).toBe(connection);
      expect(getBlockHeight).not.toHaveBeenCalled();
    });

    it("does not run the manual health-check when setup started a managed devnode", async () => {
      const getBlockHeight = vi.fn().mockRejectedValue(new Error("should not run"));
      const connection = createMockConnection({ getBlockHeight });
      const lre = mockLre({ connection });

      const ctx = await setup({ lre });

      expect(ctx.connection).toBe(connection);
      expect(getBlockHeight).not.toHaveBeenCalled();
    });

    it("times out manual devnode reachability checks with the same clear error shape", async () => {
      vi.useFakeTimers();
      const getBlockHeight = vi.fn(() => new Promise<number>(() => {}));
      const connection = createMockConnection({ getBlockHeight });
      const lre = mockLre({ connection });

      const setupPromise = setup({ lre, skipDevnode: true });
      const assertion = expect(setupPromise).rejects.toThrow(
        /Devnode network "devnode" is not reachable at http:\/\/127\.0\.0\.1:3030 .*setup\(\{ skipDevnode: true \}\) was passed.*Cause: manual devnode health check timed out after 5000ms/,
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await assertion;
      expect(connection.close).toHaveBeenCalledOnce();
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
      expect(startDevnode).toHaveBeenCalledWith(lre.config, undefined);
    });

    it("passes explicit autoBlock override when caller sets it", async () => {
      const lre = mockLre();
      await setup({ lre, autoBlock: false });

      const { startDevnode } = await import("./devnode-lifecycle.js");
      expect(startDevnode).toHaveBeenCalledWith(lre.config, { autoBlock: false });
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
        noSkipDeployed: undefined,
      });
      expect(result.programId).toBe("hello.aleo");
      expect(result.txId).toBe("at1deploy");
    });

    it("forwards the connected setup network to the deploy task", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true, network: "testnet" });

      await ctx.deploy("hello");

      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "hello",
        network: "testnet",
        priorityFee: undefined,
        skipConfirm: undefined,
        noCompile: undefined,
        noSkipDeployed: undefined,
      });
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
        noSkipDeployed: undefined,
      });
    });

    it("passes prove=true to deploy when LIONDEN_PROVE is set", async () => {
      process.env["LIONDEN_PROVE"] = "true";
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.deploy("token");

      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "token",
        network: "devnode",
        priorityFee: undefined,
        skipConfirm: undefined,
        noCompile: undefined,
        noSkipDeployed: undefined,
        prove: true,
      });
    });

    it("allows ctx.deploy prove=false to override LIONDEN_PROVE", async () => {
      process.env["LIONDEN_PROVE"] = "true";
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.deploy("token", { prove: false });

      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "token",
        network: "devnode",
        priorityFee: undefined,
        skipConfirm: undefined,
        noCompile: undefined,
        noSkipDeployed: undefined,
        prove: false,
      });
    });

    it("returns a cached complete deployment without calling deploy", async () => {
      const lre = mockLre();
      const getCached = vi
        .fn<DeploymentCacheAccessor["getCached"]>()
        .mockReturnValue(cachedDeployment("hello.aleo"));
      attachDeploymentCache(lre, getCached);
      const ctx = await setup({ lre, skipDevnode: true });

      const result = await ctx.deploy("hello");

      expect(result).toEqual({ programId: "hello.aleo", txId: "at1cached" });
      expect(getCached).toHaveBeenCalledWith("hello.aleo", "devnode");
      expect(lre.tasks.run).not.toHaveBeenCalled();
    });

    it("accepts wrapper identity for cached deployments", async () => {
      const lre = mockLre();
      const getCached = vi
        .fn<DeploymentCacheAccessor["getCached"]>()
        .mockReturnValue(cachedDeployment("hello.aleo"));
      attachDeploymentCache(lre, getCached);
      const ctx = await setup({ lre, skipDevnode: true });

      const result = await ctx.deploy({ programId: "hello.aleo" });

      expect(result).toEqual({ programId: "hello.aleo", txId: "at1cached" });
      expect(getCached).toHaveBeenCalledWith("hello.aleo", "devnode");
      expect(lre.tasks.run).not.toHaveBeenCalled();
    });

    it("bypasses the cached pre-check when noSkipDeployed is true", async () => {
      const lre = mockLre();
      const getCached = vi
        .fn<DeploymentCacheAccessor["getCached"]>()
        .mockReturnValue(cachedDeployment("hello.aleo"));
      attachDeploymentCache(lre, getCached);
      const ctx = await setup({ lre, skipDevnode: true });

      const result = await ctx.deploy("hello", { noSkipDeployed: true });

      expect(result).toEqual({ programId: "hello.aleo", txId: "at1deploy" });
      expect(getCached).not.toHaveBeenCalled();
      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "hello",
        network: "devnode",
        priorityFee: undefined,
        skipConfirm: undefined,
        noCompile: undefined,
        noSkipDeployed: true,
      });
    });

    it("returns complete cached state after an empty deploy result", async () => {
      const lre = mockLre();
      (lre.tasks.run as ReturnType<typeof vi.fn>).mockResolvedValue({
        mode: "deploy",
        results: [],
      });
      const getCached = vi
        .fn<DeploymentCacheAccessor["getCached"]>()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(cachedDeployment("hello.aleo", { txId: "at1post" }));
      attachDeploymentCache(lre, getCached);
      const ctx = await setup({ lre, skipDevnode: true });

      const result = await ctx.deploy("hello");

      expect(result).toEqual({ programId: "hello.aleo", txId: "at1post" });
      expect(getCached).toHaveBeenCalledTimes(2);
    });

    it("throws clearly when empty deploy results leave only degraded cached state", async () => {
      const lre = mockLre();
      (lre.tasks.run as ReturnType<typeof vi.fn>).mockResolvedValue({
        mode: "deploy",
        results: [],
      });
      const getCached = vi.fn<DeploymentCacheAccessor["getCached"]>().mockReturnValue(
        cachedDeployment("hello.aleo", {
          status: "degraded",
          txId: null,
          blockHeight: null,
        }),
      );
      attachDeploymentCache(lre, getCached);
      const ctx = await setup({ lre, skipDevnode: true });

      await expect(ctx.deploy("hello")).rejects.toThrow(
        /no complete cached deployment with a txId exists for "hello\.aleo".*degraded record without txId/s,
      );
    });

    it("throws clearly when empty deploy results have no complete cached state", async () => {
      const lre = mockLre();
      (lre.tasks.run as ReturnType<typeof vi.fn>).mockResolvedValue({
        mode: "deploy",
        results: [],
      });
      attachDeploymentCache(
        lre,
        vi.fn<DeploymentCacheAccessor["getCached"]>().mockReturnValue(null),
      );
      const ctx = await setup({ lre, skipDevnode: true });

      await expect(ctx.deploy("hello")).rejects.toThrow(
        /no complete cached deployment with a txId exists for "hello\.aleo".*cached state: none/s,
      );
    });

    it("passes noSkipDeployed through to the deploy task", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.deploy("token", { noSkipDeployed: true });

      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "token",
        network: "devnode",
        priorityFee: undefined,
        skipConfirm: undefined,
        noCompile: undefined,
        noSkipDeployed: true,
      });
    });

    it("accepts wrapper identity when cache skipping is disabled", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.deploy({ programId: "hello.aleo" }, { noSkipDeployed: true });

      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "hello.aleo",
        network: "devnode",
        priorityFee: undefined,
        skipConfirm: undefined,
        noCompile: undefined,
        noSkipDeployed: true,
      });
    });
  });

  describe("ctx.execute", () => {
    it("defaults to onchain mode with prove=false", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", ["1u32", "2u32"]);

      expect(ctx.connection.execute).toHaveBeenCalledWith("hello.aleo", "main", ["1u32", "2u32"], {
        mode: "onchain",
        fee: undefined,
        prove: false,
        signer: undefined,
        awaitConfirmation: true,
      });
    });

    it("passes prove=true when LIONDEN_PROVE is set", async () => {
      process.env["LIONDEN_PROVE"] = "true";
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", ["1u32"]);

      expect(ctx.connection.execute).toHaveBeenCalledWith("hello.aleo", "main", ["1u32"], {
        mode: "onchain",
        fee: undefined,
        prove: true,
        signer: undefined,
        awaitConfirmation: true,
      });
    });

    it("explicit mode overrides default", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", [], { mode: "local" });

      expect(ctx.connection.execute).toHaveBeenCalledWith("hello.aleo", "main", [], {
        mode: "local",
        fee: undefined,
        prove: false,
        signer: undefined,
      });
    });

    it("passes execution options", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", [], { mode: "onchain", fee: 500 });

      expect(ctx.connection.execute).toHaveBeenCalledWith("hello.aleo", "main", [], {
        mode: "onchain",
        fee: 500,
        prove: false,
        signer: undefined,
        awaitConfirmation: true,
      });
    });

    it("forwards awaitConfirmation: false to the underlying connection", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.execute("hello.aleo", "main", [], { awaitConfirmation: false });

      expect(ctx.connection.execute).toHaveBeenCalledWith("hello.aleo", "main", [], {
        mode: "onchain",
        fee: undefined,
        prove: false,
        signer: undefined,
        awaitConfirmation: false,
      });
    });

    it("surfaces rawOutputs when the underlying connection returns them", async () => {
      const connection = createMockConnection({
        execute: vi.fn().mockResolvedValue({
          outputs: ["1u32"],
          rawOutputs: ["1u32"],
          txId: "at1exec",
        }),
      });
      const lre = mockLre({ connection });
      const ctx = await setup({ lre, skipDevnode: true });

      const result = await ctx.execute("hello.aleo", "main", []);
      expect(result.rawOutputs).toEqual(["1u32"]);
      expect(result.outputs).toEqual(["1u32"]);
      expect(result.txId).toBe("at1exec");
    });
  });

  describe("ctx.raw.execute", () => {
    it("exposes the explicit raw execution escape hatch", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.raw.execute("hello.aleo", "post_upgrade", ["1u32"], { mode: "local" });

      expect(ctx.connection.execute).toHaveBeenCalledWith("hello.aleo", "post_upgrade", ["1u32"], {
        mode: "local",
        fee: undefined,
        prove: false,
        signer: undefined,
      });
    });

    it("defaults to awaitConfirmation: true on the on-chain path", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre, skipDevnode: true });

      await ctx.raw.execute("hello.aleo", "post_upgrade", ["1u32"]);

      expect(ctx.connection.execute).toHaveBeenCalledWith("hello.aleo", "post_upgrade", ["1u32"], {
        mode: "onchain",
        fee: undefined,
        prove: false,
        signer: undefined,
        awaitConfirmation: true,
      });
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

  describe("snapshot reset", () => {
    it("snapshot/restore throw without snapshotReset", async () => {
      const lre = mockLre();
      const ctx = await setup({ lre });
      await expect(ctx.snapshot()).rejects.toThrow(/snapshotReset/);
      await expect(ctx.restore("x")).rejects.toThrow(/snapshotReset/);
    });

    it("snapshotReset requires an auto-started devnode", async () => {
      const lre = mockLre();
      await expect(setup({ lre, skipDevnode: true, snapshotReset: true })).rejects.toThrow(
        /auto-started/,
      );
    });

    it("ctx.restore invalidates the deployment session cache", async () => {
      const restore = vi.fn().mockResolvedValue(undefined);
      const { startDevnode } = await import("./devnode-lifecycle.js");
      vi.mocked(startDevnode).mockResolvedValueOnce({
        manager: { stop: vi.fn(), restore, capabilities: { snapshot: true } } as never,
        endpoint: "http://127.0.0.1:3030",
      });
      const lre = mockLre();
      const invalidateSession = vi.fn();
      Object.defineProperty(lre, "deployments", {
        value: { getCached: vi.fn(), invalidateSession },
      });

      const ctx = await setup({ lre, snapshotReset: true });
      await ctx.restore("snap");

      expect(restore).toHaveBeenCalledWith("snap");
      expect(invalidateSession).toHaveBeenCalledWith(ctx.network);
    });

    it("allocates a temp storage dir and removes it on teardown", async () => {
      const { startDevnode } = await import("./devnode-lifecycle.js");
      let passedStoragePath: string | undefined;
      vi.mocked(startDevnode).mockImplementationOnce(async (_cfg, overrides) => {
        passedStoragePath = overrides?.storagePath;
        return {
          manager: { stop: vi.fn(), capabilities: { snapshot: true } } as never,
          endpoint: "http://127.0.0.1:3030",
        };
      });
      const lre = mockLre();
      const ctx = await setup({ lre, snapshotReset: true });

      expect(passedStoragePath).toBeDefined();
      const parent = path.dirname(passedStoragePath!);
      expect(existsSync(parent)).toBe(true);

      await ctx.teardown();
      expect(existsSync(parent)).toBe(false);
    });

    it("removes the temp storage dir when startup fails", async () => {
      const { startDevnode } = await import("./devnode-lifecycle.js");
      let passedStoragePath: string | undefined;
      vi.mocked(startDevnode).mockImplementationOnce(async (_cfg, overrides) => {
        passedStoragePath = overrides?.storagePath;
        throw new Error("aleo-devnode not found");
      });
      const lre = mockLre();

      await expect(setup({ lre, snapshotReset: true })).rejects.toThrow("aleo-devnode not found");
      expect(passedStoragePath).toBeDefined();
      expect(existsSync(path.dirname(passedStoragePath!))).toBe(false);
    });
  });
});
