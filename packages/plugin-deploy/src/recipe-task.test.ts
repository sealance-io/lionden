import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import { createMockConnection } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentManager } from "./deployment-manager.js";
import type { DeploymentRecord } from "./deployment-types.js";
import { DeployError } from "./errors.js";
import { createCliDeploymentContext, recipeAction } from "./recipe-task.js";

function completeRecord(programId: string, txId = "at1cached"): DeploymentRecord {
  return {
    status: "complete",
    programId,
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    updatedAt: "2026-05-13T00:00:00.000Z",
    edition: 1,
    historyCount: 1,
    txId,
    blockHeight: 1,
    deployerAddress: "aleo1deployer",
    deployedAt: "2026-05-13T00:00:00.000Z",
  };
}

function degradedRecord(programId: string, sourceProgramId?: string): DeploymentRecord {
  return {
    status: "degraded",
    programId,
    ...(sourceProgramId === undefined ? {} : { sourceProgramId }),
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    updatedAt: "2026-05-13T00:00:00.000Z",
    edition: 1,
    historyCount: 1,
    txId: null,
    blockHeight: null,
    deployerAddress: null,
    deployedAt: null,
    feePaid: null,
  };
}

function mockDeploymentManager(
  getCached = vi.fn<DeploymentManager["getCached"]>().mockReturnValue(null),
): DeploymentManager {
  return {
    getCached,
  } as unknown as DeploymentManager;
}

function mockLre(
  options: { readonly taskResult?: unknown; readonly deployments?: DeploymentManager | null } = {},
): LionDenRuntimeEnvironment {
  return {
    namedAccounts: {},
    deployments: options.deployments ?? mockDeploymentManager(),
    tasks: {
      run: vi.fn().mockResolvedValue(
        options.taskResult ?? {
          mode: "deploy",
          results: [{ programId: "hello.aleo", txId: "at1deploy" }],
        },
      ),
    },
  } as unknown as LionDenRuntimeEnvironment;
}

describe("recipe compile network forwarding", () => {
  let tmpDir: string;
  let recipeFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-recipe-net-"));
    recipeFile = path.join(tmpDir, "recipe.mjs");
    fs.writeFileSync(recipeFile, "export default async () => ({ ok: true });\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockRecipeLre(defaultNetwork = "devnode"): {
    lre: LionDenRuntimeEnvironment;
    run: ReturnType<typeof vi.fn>;
  } {
    const run = vi.fn().mockResolvedValue(undefined);
    const lre = {
      config: { defaultNetwork, paths: { root: tmpDir } },
      globalOptions: {},
      namedAccounts: {},
      deployments: null,
      tasks: { run },
      network: { connect: vi.fn().mockResolvedValue(createMockConnection()) },
    } as unknown as LionDenRuntimeEnvironment;
    return { lre, run };
  }

  it("forwards an explicit network into the implicit compile", async () => {
    const { lre, run } = mockRecipeLre();

    await recipeAction({ file: recipeFile, network: "testnet" }, lre);

    expect(run).toHaveBeenCalledWith("compile", { network: "testnet" });
  });

  it("omits network from the implicit compile on a default run", async () => {
    const { lre, run } = mockRecipeLre();

    await recipeAction({ file: recipeFile }, lre);

    // A default run forwards nothing — compile falls back to config.defaultNetwork.
    expect(run).toHaveBeenCalledWith("compile");
  });
});

describe("recipe deployment context", () => {
  it("returns a cached complete deployment without calling deploy", async () => {
    const getCached = vi
      .fn<DeploymentManager["getCached"]>()
      .mockReturnValue(completeRecord("hello.aleo"));
    const lre = mockLre({ deployments: mockDeploymentManager(getCached) });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    const result = await ctx.deploy("hello");

    expect(result).toEqual({ programId: "hello.aleo", txId: "at1cached" });
    expect(getCached).toHaveBeenCalledWith("hello.aleo", "devnode");
    expect(lre.tasks.run).not.toHaveBeenCalled();
  });

  it("does not reuse a plain cached record bound to a different source id", async () => {
    const getCached = vi
      .fn<DeploymentManager["getCached"]>()
      .mockReturnValue({ ...completeRecord("tenant.aleo"), sourceProgramId: "hello.aleo" });
    const lre = mockLre({
      deployments: mockDeploymentManager(getCached),
      taskResult: {
        mode: "deploy",
        results: [{ programId: "tenant.aleo", txId: "at1deploy" }],
      },
    });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    const result = await ctx.deploy("tenant");

    expect(result).toEqual({ programId: "tenant.aleo", txId: "at1deploy" });
    expect(getCached).toHaveBeenCalledWith("tenant.aleo", "devnode");
    expect(lre.tasks.run).toHaveBeenCalledWith(
      "deploy",
      expect.objectContaining({
        program: "tenant",
      }),
    );
  });

  it("accepts wrapper identity for cached deployments", async () => {
    const getCached = vi
      .fn<DeploymentManager["getCached"]>()
      .mockReturnValue(completeRecord("hello.aleo"));
    const lre = mockLre({ deployments: mockDeploymentManager(getCached) });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    const result = await ctx.deploy({ programId: "hello.aleo" });

    expect(result).toEqual({ programId: "hello.aleo", txId: "at1cached" });
    expect(getCached).toHaveBeenCalledWith("hello.aleo", "devnode");
    expect(lre.tasks.run).not.toHaveBeenCalled();
  });

  it("deploys a wrapper override by source id with rename set to runtime id", async () => {
    const lre = mockLre({
      taskResult: {
        mode: "deploy",
        results: [{ programId: "renamed_hello.aleo", txId: "at1deploy" }],
      },
    });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    const result = await ctx.deploy(
      { sourceProgramId: "hello.aleo", programId: "renamed_hello.aleo" },
      { noSkipDeployed: true },
    );

    expect(result).toEqual({
      programId: "renamed_hello.aleo",
      txId: "at1deploy",
    });
    expect(lre.tasks.run).toHaveBeenCalledWith(
      "deploy",
      expect.objectContaining({
        program: "hello.aleo",
        rename: "renamed_hello.aleo",
        noCompile: false,
      }),
    );
  });

  it("does not reuse a renamed wrapper cached under a different source id", async () => {
    const getCached = vi
      .fn<DeploymentManager["getCached"]>()
      .mockReturnValue({ ...completeRecord("tenant.aleo"), sourceProgramId: "other.aleo" });
    const lre = mockLre({
      deployments: mockDeploymentManager(getCached),
      taskResult: {
        mode: "deploy",
        results: [{ programId: "tenant.aleo", txId: "at1deploy" }],
      },
    });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    const result = await ctx.deploy({
      sourceProgramId: "hello.aleo",
      programId: "tenant.aleo",
    });

    expect(result).toEqual({ programId: "tenant.aleo", txId: "at1deploy" });
    expect(getCached).toHaveBeenCalledWith("tenant.aleo", "devnode");
    expect(lre.tasks.run).toHaveBeenCalledWith(
      "deploy",
      expect.objectContaining({
        program: "hello.aleo",
        rename: "tenant.aleo",
      }),
    );
  });

  it("respects explicit noCompile for renamed wrapper deploys", async () => {
    const lre = mockLre({
      taskResult: {
        mode: "deploy",
        results: [{ programId: "renamed_hello.aleo", txId: "at1deploy" }],
      },
    });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    await ctx.deploy(
      { sourceProgramId: "hello.aleo", programId: "renamed_hello.aleo" },
      { noCompile: true, noSkipDeployed: true },
    );

    expect(lre.tasks.run).toHaveBeenCalledWith(
      "deploy",
      expect.objectContaining({
        program: "hello.aleo",
        rename: "renamed_hello.aleo",
        noCompile: true,
      }),
    );
  });

  it("bypasses the cached pre-check when noSkipDeployed is true", async () => {
    const getCached = vi
      .fn<DeploymentManager["getCached"]>()
      .mockReturnValue(completeRecord("hello.aleo"));
    const lre = mockLre({ deployments: mockDeploymentManager(getCached) });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    const result = await ctx.deploy("hello", { noSkipDeployed: true });

    expect(result).toEqual({ programId: "hello.aleo", txId: "at1deploy" });
    expect(getCached).not.toHaveBeenCalled();
    expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
      program: "hello",
      network: "devnode",
      noCompile: true,
      priorityFee: undefined,
      noSkipDeployed: true,
      prove: false,
    });
  });

  it("returns complete cached state after an empty deploy result", async () => {
    const getCached = vi
      .fn<DeploymentManager["getCached"]>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(completeRecord("hello.aleo", "at1post"));
    const lre = mockLre({
      deployments: mockDeploymentManager(getCached),
      taskResult: { mode: "deploy", results: [] },
    });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    const result = await ctx.deploy("hello");

    expect(result).toEqual({ programId: "hello.aleo", txId: "at1post" });
    expect(getCached).toHaveBeenCalledTimes(2);
  });

  it("throws DeployError when empty deploy results leave only degraded cached state", async () => {
    const getCached = vi
      .fn<DeploymentManager["getCached"]>()
      .mockReturnValue(degradedRecord("hello.aleo"));
    const lre = mockLre({
      deployments: mockDeploymentManager(getCached),
      taskResult: { mode: "deploy", results: [] },
    });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    await expect(ctx.deploy("hello")).rejects.toThrow(DeployError);
    await expect(ctx.deploy("hello")).rejects.toThrow(
      /no complete cached deployment with a txId exists for "hello\.aleo".*degraded record without txId/s,
    );
  });

  it("throws DeployError when empty deploy results have no complete cached state", async () => {
    const lre = mockLre({
      deployments: mockDeploymentManager(),
      taskResult: { mode: "deploy", results: [] },
    });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    await expect(ctx.deploy("hello")).rejects.toThrow(
      /no complete cached deployment with a txId exists for "hello\.aleo".*cached state: none/s,
    );
  });

  it("throws when nonempty deploy results do not include the requested program", async () => {
    const lre = mockLre({
      deployments: mockDeploymentManager(),
      taskResult: {
        mode: "deploy",
        results: [{ programId: "other.aleo", txId: "at1other" }],
      },
    });
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    await expect(ctx.deploy("requested")).rejects.toThrow(
      /no complete cached deployment with a txId exists for "requested\.aleo".*cached state: none/s,
    );
  });

  it("forwards noSkipDeployed to the deploy task", async () => {
    const lre = mockLre();
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    await ctx.deploy("hello", { noSkipDeployed: true });

    expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
      program: "hello",
      network: "devnode",
      noCompile: true,
      priorityFee: undefined,
      noSkipDeployed: true,
      prove: false,
    });
  });

  it("accepts wrapper identity when cache skipping is disabled", async () => {
    const lre = mockLre();
    const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode");

    await ctx.deploy({ programId: "hello.aleo" }, { noSkipDeployed: true });

    expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
      program: "hello.aleo",
      network: "devnode",
      noCompile: true,
      priorityFee: undefined,
      noSkipDeployed: true,
      prove: false,
    });
  });

  describe("prove forwarding", () => {
    it("ctx.execute forwards the resolved run-level prove", async () => {
      const lre = mockLre();
      const conn = createMockConnection();
      const ctx = createCliDeploymentContext(lre, conn, "devnode", true);

      await ctx.execute("hello.aleo", "main", ["1u32"]);

      expect(conn.execute).toHaveBeenCalledWith(
        "hello.aleo",
        "main",
        ["1u32"],
        expect.objectContaining({ prove: true }),
      );
    });

    it("ctx.execute per-call prove=false overrides the run-level prove", async () => {
      const lre = mockLre();
      const conn = createMockConnection();
      const ctx = createCliDeploymentContext(lre, conn, "devnode", true);

      await ctx.execute("hello.aleo", "main", ["1u32"], { prove: false });

      expect(conn.execute).toHaveBeenCalledWith(
        "hello.aleo",
        "main",
        ["1u32"],
        expect.objectContaining({ prove: false }),
      );
    });

    it("ctx.execute defaults to prove=false when the run-level prove is unset", async () => {
      const lre = mockLre();
      const conn = createMockConnection();
      const ctx = createCliDeploymentContext(lre, conn, "devnode");

      await ctx.execute("hello.aleo", "main", ["1u32"]);

      expect(conn.execute).toHaveBeenCalledWith(
        "hello.aleo",
        "main",
        ["1u32"],
        expect.objectContaining({ prove: false }),
      );
    });

    it("ctx.deploy forwards a per-call prove opt-out into the deploy task", async () => {
      const lre = mockLre();
      const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode", true);

      await ctx.deploy("hello", { noSkipDeployed: true, prove: false });

      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "hello",
        network: "devnode",
        noCompile: true,
        priorityFee: undefined,
        noSkipDeployed: true,
        prove: false,
      });
    });

    it("ctx.deploy inherits the run-level prove when no per-call override is given", async () => {
      const lre = mockLre();
      const ctx = createCliDeploymentContext(lre, createMockConnection(), "devnode", true);

      await ctx.deploy("hello", { noSkipDeployed: true });

      // Mirrors ctx.execute: the authoritative run-level prove is forwarded so a
      // programmatic recipe prove (or --prove) reaches the deploy task too — it
      // is NOT silently dropped to the deploy task's own self-resolution.
      expect(lre.tasks.run).toHaveBeenCalledWith("deploy", {
        program: "hello",
        network: "devnode",
        noCompile: true,
        priorityFee: undefined,
        noSkipDeployed: true,
        prove: true,
      });
    });
  });
});
