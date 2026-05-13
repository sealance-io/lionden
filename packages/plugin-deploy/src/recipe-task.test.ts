import { describe, it, expect, vi } from "vitest";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import { createMockConnection } from "@lionden/test-internals";
import { createCliDeploymentContext } from "./recipe-task.js";
import { DeployError } from "./errors.js";
import type { DeploymentManager } from "./deployment-manager.js";
import type { DeploymentRecord } from "./deployment-types.js";

function completeRecord(programId: string, txId = "at1cached"): DeploymentRecord {
  return {
    status: "complete",
    programId,
    edition: 0,
    constructor: { type: "noupgrade" },
    abiHash: "hash",
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    updatedAt: "2026-05-13T00:00:00.000Z",
    historyCount: 1,
    txId,
    blockHeight: 1,
    deployerAddress: "aleo1deployer",
    deployedAt: "2026-05-13T00:00:00.000Z",
  };
}

function degradedRecord(programId: string): DeploymentRecord {
  return {
    status: "degraded",
    programId,
    edition: 0,
    constructor: { type: null },
    abiHash: null,
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    updatedAt: "2026-05-13T00:00:00.000Z",
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

function mockLre(options: {
  readonly taskResult?: unknown;
  readonly deployments?: DeploymentManager | null;
} = {}): LionDenRuntimeEnvironment {
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
    });
  });
});
