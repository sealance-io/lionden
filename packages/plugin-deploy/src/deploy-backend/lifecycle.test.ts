/**
 * Step-0 lifecycle contract for the deploy backend.
 *
 * `backend.preflight()` is the fail-fast gate: an unusable backend must be
 * rejected before `deployAction` compiles anything and before `upgradeAction`
 * opens a network connection. Both orderings are load-bearing — the whole point
 * of hoisting resolution to step 0 is that the user does not wait through a full
 * compile to learn the backend cannot run.
 */

import { type NetworkManager, SdkDiagnostics } from "@lionden/network";
import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployAction } from "../deploy-task.js";
import { DeploymentManagerImpl } from "../deployment-manager.js";
import { upgradeAction } from "../upgrade-task.js";
import type { DeployBackend } from "./types.js";

const mockCreateSdkObjects = vi.hoisted(() => vi.fn());
const mockResolveDeployBackend = vi.hoisted(() => vi.fn());

vi.mock("@lionden/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/network")>();
  return {
    ...original,
    createSdkObjects: mockCreateSdkObjects,
    checkDevnodeSdkSupport: vi.fn().mockResolvedValue(undefined),
    initConsensusHeights: vi.fn().mockResolvedValue(undefined),
  };
});

// Only `resolveDeployBackend` is swapped; the context builders stay real so the
// test still exercises the actual config → context mapping.
vi.mock("./resolve.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./resolve.js")>();
  return { ...original, resolveDeployBackend: mockResolveDeployBackend };
});

const PREFLIGHT_FAILURE = "backend preflight rejected for test";

/** A backend whose only observable behavior is that `preflight()` rejects. */
function rejectingBackend(): DeployBackend {
  return {
    provider: "sdk",
    capabilities: {
      buildWithoutBroadcast: true,
      feeEstimation: true,
      resumableKeySynthesis: false,
    },
    preflight: vi.fn().mockRejectedValue(new Error(PREFLIGHT_FAILURE)),
    buildDeploy: vi.fn(),
    buildUpgrade: vi.fn(),
    estimateDeploymentFee: vi.fn(),
  };
}

describe("deploy backend step-0 lifecycle", () => {
  let fixture: ContractLreResult;

  beforeEach(() => {
    mockResolveDeployBackend.mockReset();
    mockCreateSdkObjects.mockReset();
    mockCreateSdkObjects.mockResolvedValue({
      programManager: {},
      account: { address: () => ({ to_string: () => "aleo1testdeployer" }) },
      diagnostics: new SdkDiagnostics(),
    });
  });

  afterEach(() => {
    fixture?.cleanup();
    vi.restoreAllMocks();
  });

  function createFixture() {
    fixture = createContractLre({
      programs: [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      withNetwork: true,
      withMockCompile: true,
      prePopulateArtifacts: [
        {
          programId: "hello.aleo",
          abi: {
            program: "hello.aleo",
            structs: [],
            records: [],
            mappings: [],
            storage_variables: [],
            transitions: [],
          },
          aleoSource: "program hello.aleo;\n",
        },
      ],
    });
    const manager = new DeploymentManagerImpl(
      fixture.lre.config,
      () => fixture.lre.network as NetworkManager | null,
      fixture.lre.artifacts,
    );
    (fixture.lre as unknown as Record<string, unknown>)["deployments"] = manager;
    return fixture;
  }

  it("rejects a deploy before any compilation happens", async () => {
    const { lre } = createFixture();
    const backend = rejectingBackend();
    mockResolveDeployBackend.mockReturnValue(backend);

    const runTask = vi.spyOn(lre.tasks, "run");

    await expect(deployAction({ program: "hello" }, lre)).rejects.toThrow(PREFLIGHT_FAILURE);

    expect(backend.preflight).toHaveBeenCalledTimes(1);
    // `deployAction`'s step 1 is the compile task. Nothing may have run.
    expect(runTask).not.toHaveBeenCalled();
    expect(backend.buildDeploy).not.toHaveBeenCalled();
  });

  it("rejects an upgrade before any network connection is opened", async () => {
    const { lre } = createFixture();
    const backend = rejectingBackend();
    mockResolveDeployBackend.mockReturnValue(backend);

    const networkManager = lre.network as NetworkManager;
    const connect = vi.spyOn(networkManager, "connect");
    const runTask = vi.spyOn(lre.tasks, "run");

    await expect(upgradeAction({ program: "hello" }, lre)).rejects.toThrow(PREFLIGHT_FAILURE);

    expect(backend.preflight).toHaveBeenCalledTimes(1);
    // `upgradeAction`'s step 1 is connect (not compile, unlike deploy).
    expect(connect).not.toHaveBeenCalled();
    expect(runTask).not.toHaveBeenCalled();
    expect(backend.buildUpgrade).not.toHaveBeenCalled();
  });

  it("preflights with a context that carries no connection-derived fields", async () => {
    const { lre } = createFixture();
    const backend = rejectingBackend();
    mockResolveDeployBackend.mockReturnValue(backend);

    await expect(deployAction({ program: "hello" }, lre)).rejects.toThrow(PREFLIGHT_FAILURE);

    const ctx = (backend.preflight as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(ctx.networkName).toBe("devnode");
    expect(ctx.connectionType).toBe("devnode");
    // `egressPolicy` is built per-connection, so it must be absent at step 0.
    expect(ctx).not.toHaveProperty("egressPolicy");
  });
});
