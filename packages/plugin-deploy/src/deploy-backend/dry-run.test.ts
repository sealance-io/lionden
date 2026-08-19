/**
 * `--dry-run` contract.
 *
 * Dry-run is gated on `capabilities.buildWithoutBroadcast` rather than on the
 * connection type, and it must never broadcast or touch deployment state. The
 * adversarial case — a backend that advertises the capability and broadcasts
 * anyway — is the one the SDK-only contract fixtures cannot reach, since the
 * real `SdkDeployBackend` never lies about it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type NetworkManager, SdkDiagnostics } from "@lionden/network";
import { type ContractLreResult, createContractLre } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeployTaskResult, deployAction } from "../deploy-task.js";
import { DeploymentManagerImpl } from "../deployment-manager.js";
import { createLeoDeployBackend } from "./leo-backend.js";
import { createSdkDeployBackend } from "./sdk-backend.js";
import type { DeployBackend, DeployBackendResult } from "./types.js";

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

/**
 * Kept aside so a test can put the *real* resolver back for one run. Most tests
 * here need a stub backend that can lie about its capabilities — something no
 * real backend does — but the SDK-on-HTTP rejection is precisely about whether
 * selection and context wiring produce the right backend, so it has to use the
 * genuine article.
 */
const realResolveDeployBackend = vi.hoisted(() => ({
  current: undefined as typeof import("./resolve.js").resolveDeployBackend | undefined,
}));

vi.mock("./resolve.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./resolve.js")>();
  realResolveDeployBackend.current = original.resolveDeployBackend;
  return { ...original, resolveDeployBackend: mockResolveDeployBackend };
});

function stubBackend(opts: {
  buildWithoutBroadcast: boolean;
  result?: DeployBackendResult;
}): DeployBackend {
  return {
    provider: "sdk",
    capabilities: {
      buildWithoutBroadcast: opts.buildWithoutBroadcast,
      feeEstimation: true,
      resumableKeySynthesis: false,
    },
    preflight: vi.fn().mockResolvedValue(undefined),
    buildDeploy: vi
      .fn()
      .mockResolvedValue(opts.result ?? { kind: "built", transaction: "dry-run-tx-bytes" }),
    buildUpgrade: vi.fn(),
    estimateDeploymentFee: vi.fn().mockResolvedValue({ estimate: undefined, warning: null }),
  };
}

function unwrapDryRun(result: DeployTaskResult) {
  if (result.mode !== "dry-run") throw new Error(`Expected dry-run mode, got: ${result.mode}`);
  return result.results;
}

describe("deploy --dry-run contract", () => {
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

  /**
   * @param http Configure the project against a real HTTP network named
   * `testnet` — config entry, connection type and all — instead of the devnode.
   * The gate reads a capability, but the capability comes from the connection
   * type, so a test about SDK-on-HTTP has to have one.
   */
  function createFixture({ http = false }: { http?: boolean } = {}) {
    const networkName = http ? "testnet" : "devnode";
    fixture = createContractLre({
      programs: [{ name: "hello", annotation: "@noupgrade\n    constructor() {}" }],
      // Non-ephemeral, or `record()` writes nothing and the "no state written"
      // assertions below would pass vacuously.
      configOverrides: {
        networks: http
          ? {
              testnet: {
                type: "http",
                endpoint: "https://api.explorer.provable.com/v1",
                network: "testnet",
                privateKey: "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
                ephemeral: false,
              },
            }
          : {
              devnode: {
                type: "devnode",
                socketAddr: "127.0.0.1:3030",
                autoBlock: true,
                verbosity: 0,
                accounts: [],
                network: "testnet",
                ephemeral: false,
              },
            },
      },
      withNetwork: http
        ? { type: "http", name: networkName, endpoint: "https://api.explorer.provable.com/v1" }
        : true,
      knownNetworks: [networkName],
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
    return { lre: fixture.lre, fakeNetwork: fixture.fakeNetwork!, networkName };
  }

  it("the SDK backend cannot build without broadcasting on HTTP", () => {
    // The capability, not the connection type, is what the gate reads — so this
    // is the fact that keeps SDK+HTTP dry-run rejected.
    expect(createSdkDeployBackend("http").capabilities.buildWithoutBroadcast).toBe(false);
    expect(createSdkDeployBackend("devnode").capabilities.buildWithoutBroadcast).toBe(true);
  });

  /**
   * The Leo backend's capability is unconditional, because `--save` without
   * `--broadcast` is exactly a dry run and nothing on its path is atomic. That
   * is what makes `--deploy-backend leo --dryRun` work against a real network,
   * where the SDK's atomic build-and-broadcast cannot — exercised end to end in
   * `leo-deploy-orchestration.contract.test.ts`.
   */
  it("the Leo backend can always build without broadcasting", () => {
    expect(createLeoDeployBackend().capabilities.buildWithoutBroadcast).toBe(true);
  });

  /**
   * The rejection has to name the backend that cannot do it, and the one that
   * can. "Dry-run is not supported for HTTP networks" was true only while the
   * Leo backend was devnode-only; said today it would send a user looking for a
   * limit that no longer exists.
   */
  it("rejects when the backend cannot build without broadcasting", async () => {
    const { lre, fakeNetwork } = createFixture();
    const backend = stubBackend({ buildWithoutBroadcast: false });
    mockResolveDeployBackend.mockReturnValue(backend);

    await expect(
      deployAction({ program: "hello", noCompile: true, dryRun: true }, lre),
    ).rejects.toThrow(/The sdk deploy backend cannot dry-run against network "devnode"/);

    expect(backend.buildDeploy).not.toHaveBeenCalled();
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
  });

  it("points at the backend that can dry-run, not only at --preflight", async () => {
    const { lre } = createFixture();
    mockResolveDeployBackend.mockReturnValue(stubBackend({ buildWithoutBroadcast: false }));

    let message = "";
    try {
      await deployAction({ program: "hello", noCompile: true, dryRun: true }, lre);
      expect.unreachable();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("--deploy-backend leo");
    expect(message).toContain("--preflight");
    // The old wording named a connection type. The capability is what decides.
    expect(message).not.toMatch(/HTTP networks in v1/);
  });

  /**
   * SDK + HTTP + `--dryRun`, with nothing simulated between config and the
   * gate: a real HTTP network entry, a real HTTP connection, the real resolver
   * picking the backend, and the real `SdkDeployBackend` reporting that it
   * cannot build without broadcasting.
   *
   * Injecting `createSdkDeployBackend("http")` through the stub instead would
   * assert only that a backend saying `false` is refused — which the test above
   * already covers — while the project underneath stayed on devnode. Broken
   * HTTP selection or context wiring would sail straight past it.
   */
  it("rejects the real SDK backend on a real HTTP network", async () => {
    const { lre, fakeNetwork, networkName } = createFixture({ http: true });
    mockResolveDeployBackend.mockImplementation(realResolveDeployBackend.current!);

    await expect(
      deployAction({ program: "hello", network: networkName, noCompile: true, dryRun: true }, lre),
    ).rejects.toThrow(/The sdk deploy backend cannot dry-run against network "testnet"/);

    // The connection really was HTTP — otherwise the SDK backend would have
    // advertised `buildWithoutBroadcast` and this would never have thrown.
    expect(fakeNetwork.type).toBe("http");
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);

    const manager = lre.deployments as DeploymentManagerImpl;
    expect(manager.getCached("hello.aleo", networkName)).toBeNull();
  });

  it("returns an unbroadcast transaction and touches no deployment state", async () => {
    const { lre, fakeNetwork } = createFixture();
    mockResolveDeployBackend.mockReturnValue(stubBackend({ buildWithoutBroadcast: true }));

    const results = unwrapDryRun(
      await deployAction({ program: "hello", noCompile: true, dryRun: true }, lre),
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.programId).toBe("hello.aleo");
    expect(results[0]!.transaction).toBe("dry-run-tx-bytes");

    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
    expect(fakeNetwork.getCallsTo("waitForConfirmation")).toHaveLength(0);

    const manager = lre.deployments as DeploymentManagerImpl;
    expect(manager.getCached("hello.aleo", "devnode")).toBeNull();
    expect(await manager.getPending("devnode", "hello.aleo")).toBeNull();

    // Nothing on disk either — not a record, not a pending marker.
    const deploymentsDir = lre.config.paths.deployments;
    const written = fs.existsSync(path.join(deploymentsDir, "devnode"))
      ? fs.readdirSync(path.join(deploymentsDir, "devnode"))
      : [];
    expect(written).toEqual([]);
  });

  it("control: the same fixture DOES write state on a real deploy", async () => {
    // Without this, the "no state written" assertions above could pass simply
    // because the fixture never writes anything.
    const { lre, fakeNetwork } = createFixture();
    mockResolveDeployBackend.mockReturnValue(stubBackend({ buildWithoutBroadcast: true }));

    await deployAction({ program: "hello", noCompile: true }, lre);

    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(1);
    const manager = lre.deployments as DeploymentManagerImpl;
    expect(manager.getCached("hello.aleo", "devnode")).not.toBeNull();
    expect(
      fs.readdirSync(path.join(lre.config.paths.deployments, "devnode")).length,
    ).toBeGreaterThan(0);
  });

  it("throws when a backend broadcasts despite claiming buildWithoutBroadcast", async () => {
    const { lre, fakeNetwork } = createFixture();
    const backend = stubBackend({
      buildWithoutBroadcast: true,
      result: { kind: "broadcast", txId: "at1shouldnothavebroadcast" },
    });
    mockResolveDeployBackend.mockReturnValue(backend);

    await expect(
      deployAction({ program: "hello", noCompile: true, dryRun: true }, lre),
    ).rejects.toThrow(/at1shouldnothavebroadcast/);

    // The bug is the backend's, but lionden must not compound it by recording
    // the transaction it was told not to produce.
    expect(fakeNetwork.getCallsTo("broadcastTransaction")).toHaveLength(0);
    const manager = lre.deployments as DeploymentManagerImpl;
    expect(manager.getCached("hello.aleo", "devnode")).toBeNull();
  });
});
