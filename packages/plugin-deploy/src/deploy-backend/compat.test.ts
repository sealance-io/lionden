/**
 * Effective-backend compatibility checks.
 *
 * These run on the *resolved* provider rather than `config.deploy.backend`,
 * which is why they cannot live in `validateResolvedConfig` — see
 * `assertDeployBackendCompatible`'s doc comment. The tests here therefore drive
 * the provider in directly, the way `resolveDeployBackend` does.
 */

import type { LionDenResolvedConfig, ResolvedSdkKeyCacheConfig } from "@lionden/config";
import { createMockConfig } from "@lionden/test-internals";
import { describe, expect, it, vi } from "vitest";
import { DeployError } from "../errors.js";
import {
  assertDeployBackendCompatible,
  buildPreflightContext,
  resolveDeployBackend,
} from "./resolve.js";
import type { DeployBackendPreflightContext } from "./types.js";

function ctxFor(config: LionDenResolvedConfig, networkName = "devnode") {
  return buildPreflightContext(config, networkName);
}

/** A devnode config on the one Leo line the backend supports. */
function leoReadyConfig(overrides: Partial<LionDenResolvedConfig> = {}): LionDenResolvedConfig {
  const base = createMockConfig({ leoVersion: "4.3.2", ...overrides });
  return base;
}

function withKeyCache(keyCache: ResolvedSdkKeyCacheConfig): LionDenResolvedConfig {
  return leoReadyConfig({ sdk: { keyCache } });
}

describe("assertDeployBackendCompatible", () => {
  it("passes the sdk provider through untouched, whatever else is configured", () => {
    const config = createMockConfig({
      leoVersion: "3.5.0",
      sdk: {
        keyCache: { storage: "filesystem", path: "/tmp/keys" },
        egress: { violation: "warn" },
      },
    });
    expect(assertDeployBackendCompatible("sdk", ctxFor(config), "deploy")).toEqual([]);
  });

  it("accepts leo on a supported line with nothing conflicting", () => {
    expect(assertDeployBackendCompatible("leo", ctxFor(leoReadyConfig()), "deploy")).toEqual([]);
  });

  /**
   * Temporary, and removed by the PR that adds HTTP support — which also forces
   * `DEVNET=false` in the child environment and stops `buildDotEnv` writing a
   * live private key into the materialized package for HTTP networks. Both are
   * prerequisites, so shipping HTTP here would put the security-sensitive path
   * in production one PR ahead of its guards.
   *
   * It sits in the compatibility check rather than the dry-run gate because
   * `capabilities.buildWithoutBroadcast` is unconditionally true for this
   * backend, so `--deploy-backend leo --dryRun` against HTTP would otherwise be
   * admitted.
   */
  describe("HTTP is not supported yet", () => {
    function httpCtx(): DeployBackendPreflightContext {
      const config = leoReadyConfig({
        networks: {
          ...createMockConfig().networks,
          testnet: {
            type: "http",
            endpoint: "https://api.explorer.provable.com/v1",
            network: "testnet",
            ephemeral: false,
          },
        },
      });
      return buildPreflightContext(config, "testnet");
    }

    it("rejects an HTTP network", () => {
      expect(httpCtx().connectionType).toBe("http");
      expect(() => assertDeployBackendCompatible("leo", httpCtx(), "deploy")).toThrow(
        /does not support HTTP networks yet/,
      );
    });

    it("names the network and offers the SDK backend", () => {
      try {
        assertDeployBackendCompatible("leo", httpCtx(), "deploy");
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain("testnet");
        expect((error as Error).message).toContain("--deploy-backend sdk");
      }
    });

    it("blocks the dry-run path too, since resolve happens before it", () => {
      expect(() => resolveDeployBackend("leo", httpCtx(), "deploy")).toThrow(
        /does not support HTTP networks yet/,
      );
    });

    it("leaves the sdk provider on HTTP alone", () => {
      expect(assertDeployBackendCompatible("sdk", httpCtx(), "deploy")).toEqual([]);
    });
  });

  /**
   * Temporary, and removed by the PR that implements `buildUpgrade`.
   *
   * The reason it lives here rather than only in `LeoDeployBackend.buildUpgrade`
   * is ordering: `upgradeAction` calls this at step 0, but does not reach
   * `buildUpgrade` until after it has connected, recovered pending deployments,
   * compiled, and written a pending upgrade marker. Throwing only from the
   * backend leaves that marker behind on a non-ephemeral network.
   */
  describe("upgrade is not supported yet", () => {
    it("rejects leo + upgrade on an otherwise perfectly valid config", () => {
      // Nothing else here is wrong: same config, `deploy` passes.
      const ctx = ctxFor(leoReadyConfig());
      expect(assertDeployBackendCompatible("leo", ctx, "deploy")).toEqual([]);
      expect(() => assertDeployBackendCompatible("leo", ctx, "upgrade")).toThrow(DeployError);
    });

    it("says what is unsupported and offers the SDK backend", () => {
      try {
        assertDeployBackendCompatible("leo", ctxFor(leoReadyConfig()), "upgrade");
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toMatch(/cannot run `upgrade` yet/);
        expect((error as Error).message).toContain("--deploy-backend sdk");
      }
    });

    it("rejects before returning a backend, so no upgrade can start", () => {
      expect(() => resolveDeployBackend("leo", ctxFor(leoReadyConfig()), "upgrade")).toThrow(
        /cannot run `upgrade` yet/,
      );
    });

    it("leaves sdk + upgrade alone", () => {
      expect(assertDeployBackendCompatible("sdk", ctxFor(leoReadyConfig()), "upgrade")).toEqual([]);
      expect(resolveDeployBackend("sdk", ctxFor(leoReadyConfig()), "upgrade").provider).toBe("sdk");
    });
  });

  describe("hard rejections", () => {
    it("rejects a configured sdk.egress, which Leo's own requests cannot honor", () => {
      const config = leoReadyConfig({
        sdk: { keyCache: { storage: "memory" }, egress: { networkHosts: ["telemetry.example"] } },
      });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config), "deploy")).toThrow(
        DeployError,
      );
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config), "deploy")).toThrow(
        /sdk\.egress/,
      );
    });

    it("rejects a network apiKey, which Leo has no flag to send", () => {
      const config = leoReadyConfig({
        networks: {
          remote: {
            type: "http",
            endpoint: "https://api.example.com",
            network: "testnet",
            apiKey: "secret-key",
            ephemeral: false,
          },
        },
      });
      expect(() =>
        assertDeployBackendCompatible("leo", ctxFor(config, "remote"), "deploy"),
      ).toThrow(/apiKey/);
    });

    it.each([
      "3.5.0",
      "4.0.0",
      "4.1.0",
      "4.2.0",
      "4.4.0",
      "5.0.0",
    ])("rejects leoVersion %s as outside the verified 4.3 line", (leoVersion) => {
      const config = createMockConfig({ leoVersion });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config), "deploy")).toThrow(
        /supports Leo 4\.3\.x only/,
      );
    });

    it.each(["4.3.0", "4.3.2", "4.3.11"])("accepts leoVersion %s", (leoVersion) => {
      const config = createMockConfig({ leoVersion });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config), "deploy")).not.toThrow();
    });

    it("rejects an unparseable leoVersion rather than assuming it is modern", () => {
      const config = createMockConfig({ leoVersion: "4.3.0-rc.1" });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config), "deploy")).toThrow(
        DeployError,
      );
    });

    it("names the sdk escape hatch in every rejection", () => {
      const config = createMockConfig({ leoVersion: "4.1.0" });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config), "deploy")).toThrow(
        /--deploy-backend sdk/,
      );
    });
  });

  describe("warnings", () => {
    it("warns, without failing, that a filesystem key cache goes unused", () => {
      const warnings = assertDeployBackendCompatible(
        "leo",
        ctxFor(withKeyCache({ storage: "filesystem", path: "/tmp/keys/.aleo" })),
        "deploy",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.code).toBe("LEO_BACKEND_IGNORES_KEY_CACHE");
      expect(warnings[0]!.message).toContain("/tmp/keys/.aleo");
    });

    it("stays silent for a memory key cache", () => {
      expect(
        assertDeployBackendCompatible("leo", ctxFor(withKeyCache({ storage: "memory" })), "deploy"),
      ).toEqual([]);
    });

    it("does not warn for the sdk provider", () => {
      expect(
        assertDeployBackendCompatible(
          "sdk",
          ctxFor(withKeyCache({ storage: "filesystem", path: "/tmp/keys/.aleo" })),
          "deploy",
        ),
      ).toEqual([]);
    });
  });
});

describe("resolveDeployBackend", () => {
  it("returns the SDK backend for the sdk provider", () => {
    const backend = resolveDeployBackend("sdk", ctxFor(createMockConfig()), "deploy");
    expect(backend.provider).toBe("sdk");
  });

  it("returns the Leo backend for the leo provider on a supported devnode config", () => {
    const backend = resolveDeployBackend("leo", ctxFor(leoReadyConfig()), "deploy");
    expect(backend.provider).toBe("leo");
  });

  /**
   * The two capabilities that differ from the SDK backend, and that the deploy
   * task keys on. `buildWithoutBroadcast` is unconditionally true because
   * `--save` without `--broadcast` is exactly a dry run.
   */
  it("advertises unconditional build-without-broadcast and resumable synthesis", () => {
    const backend = resolveDeployBackend("leo", ctxFor(leoReadyConfig()), "deploy");
    expect(backend.capabilities.buildWithoutBroadcast).toBe(true);
    expect(backend.capabilities.resumableKeySynthesis).toBe(true);
    expect(backend.capabilities.feeEstimation).toBe(false);
  });

  /**
   * Ordering matters: a user who is both misconfigured *and* on an unsupported
   * Leo line should hear about the version, not get a backend that will fail
   * later for a reason they were never told about.
   */
  it("reports a compatibility failure instead of returning a backend", () => {
    const config = createMockConfig({ leoVersion: "4.1.0" });
    expect(() => resolveDeployBackend("leo", ctxFor(config), "deploy")).toThrow(
      /supports Leo 4\.3\.x only/,
    );
  });

  it("emits compatibility warnings and still returns a usable backend", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The warning is provider-scoped: the SDK path stays quiet.
      resolveDeployBackend(
        "sdk",
        ctxFor(withKeyCache({ storage: "filesystem", path: "/k/.aleo" })),
        "deploy",
      );
      expect(warn).not.toHaveBeenCalled();

      const backend = resolveDeployBackend(
        "leo",
        ctxFor(withKeyCache({ storage: "filesystem", path: "/k/.aleo" })),
        "deploy",
      );
      expect(backend.provider).toBe("leo");
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain("sdk.keyCache");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("buildPreflightContext completes the backend context", () => {
  it("carries the config-derived fields the Leo backend will need", () => {
    const config = createMockConfig({
      root: "/tmp/proj",
      leoVersion: "4.3.2",
      deploy: { ...createMockConfig().deploy, leo: { timeout: 42, logMode: "quiet-buffered" } },
    });
    const ctx: DeployBackendPreflightContext = buildPreflightContext(config, "devnode");

    expect(ctx.leo).toEqual({ timeout: 42, logMode: "quiet-buffered" });
    expect(ctx.projectRoot).toBe("/tmp/proj");
    expect(ctx.artifactsDir).toBe("/tmp/proj/artifacts");
    expect(ctx.leoBinary).toBe(config.leoBinary);
  });

  it("omits sdkEgress when unconfigured, so the compatibility check stays quiet", () => {
    const ctx = buildPreflightContext(createMockConfig(), "devnode");
    expect(ctx).not.toHaveProperty("sdkEgress");
  });
});
