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
    expect(assertDeployBackendCompatible("sdk", ctxFor(config))).toEqual([]);
  });

  it("accepts leo on a supported line with nothing conflicting", () => {
    expect(assertDeployBackendCompatible("leo", ctxFor(leoReadyConfig()))).toEqual([]);
  });

  /**
   * HTTP is admitted on exactly the same terms as devnode. The two things that
   * made it unsafe before are gone: `buildLeoEnv` now pins `DEVNET=false` so a
   * stale devnode-materialized package cannot drag a real deployment into
   * devnet mode, and `buildDotEnv` no longer writes a live private key into the
   * materialized package.
   *
   * The connection type still decides two flags — `--devnet` and
   * `--skip-deploy-certificate` — which is `buildLeoArgv`'s business, asserted
   * in `argv.test.ts`. Nothing about it belongs in the compatibility check.
   */
  describe("HTTP networks", () => {
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

    it("accepts leo on an HTTP network", () => {
      expect(httpCtx().connectionType).toBe("http");
      expect(assertDeployBackendCompatible("leo", httpCtx())).toEqual([]);
    });

    it("returns the Leo backend rather than falling back to the SDK", () => {
      expect(resolveDeployBackend("leo", httpCtx()).provider).toBe("leo");
    });

    /**
     * `--dryRun` keys on `capabilities.buildWithoutBroadcast`, which is
     * unconditionally true here because `--save` without `--broadcast` *is* a
     * dry run. That is now the intended HTTP dry-run path, not an oversight the
     * compatibility check has to close.
     */
    it("advertises build-without-broadcast on HTTP, enabling dry-run", () => {
      expect(resolveDeployBackend("leo", httpCtx()).capabilities.buildWithoutBroadcast).toBe(true);
    });

    it("leaves the sdk provider on HTTP alone", () => {
      expect(assertDeployBackendCompatible("sdk", httpCtx())).toEqual([]);
    });
  });

  describe("hard rejections", () => {
    it("rejects a configured sdk.egress, which Leo's own requests cannot honor", () => {
      const config = leoReadyConfig({
        sdk: { keyCache: { storage: "memory" }, egress: { networkHosts: ["telemetry.example"] } },
      });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config))).toThrow(DeployError);
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config))).toThrow(/sdk\.egress/);
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
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config, "remote"))).toThrow(
        /apiKey/,
      );
    });

    it.each(["3.5.0", "4.0.0", "4.1.0", "4.2.0", "4.4.0", "5.0.0"])(
      "rejects leoVersion %s as outside the verified 4.3 line",
      (leoVersion) => {
        const config = createMockConfig({ leoVersion });
        expect(() => assertDeployBackendCompatible("leo", ctxFor(config))).toThrow(
          /supports Leo 4\.3\.x only/,
        );
      },
    );

    it.each(["4.3.0", "4.3.2", "4.3.11"])("accepts leoVersion %s", (leoVersion) => {
      const config = createMockConfig({ leoVersion });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config))).not.toThrow();
    });

    it("rejects an unparseable leoVersion rather than assuming it is modern", () => {
      const config = createMockConfig({ leoVersion: "4.3.0-rc.1" });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config))).toThrow(DeployError);
    });

    it("names the sdk escape hatch in every rejection", () => {
      const config = createMockConfig({ leoVersion: "4.1.0" });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config))).toThrow(
        /--deploy-backend sdk/,
      );
    });
  });

  describe("warnings", () => {
    it("warns, without failing, that a filesystem key cache goes unused", () => {
      const warnings = assertDeployBackendCompatible(
        "leo",
        ctxFor(withKeyCache({ storage: "filesystem", path: "/tmp/keys/.aleo" })),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.code).toBe("LEO_BACKEND_IGNORES_KEY_CACHE");
      expect(warnings[0]!.message).toContain("/tmp/keys/.aleo");
    });

    it("stays silent for a memory key cache", () => {
      expect(
        assertDeployBackendCompatible("leo", ctxFor(withKeyCache({ storage: "memory" }))),
      ).toEqual([]);
    });

    it("does not warn for the sdk provider", () => {
      expect(
        assertDeployBackendCompatible(
          "sdk",
          ctxFor(withKeyCache({ storage: "filesystem", path: "/tmp/keys/.aleo" })),
        ),
      ).toEqual([]);
    });
  });
});

describe("resolveDeployBackend", () => {
  it("returns the SDK backend for the sdk provider", () => {
    const backend = resolveDeployBackend("sdk", ctxFor(createMockConfig()));
    expect(backend.provider).toBe("sdk");
  });

  it("returns the Leo backend for the leo provider on a supported devnode config", () => {
    const backend = resolveDeployBackend("leo", ctxFor(leoReadyConfig()));
    expect(backend.provider).toBe("leo");
  });

  /**
   * The two capabilities that differ from the SDK backend, and that the deploy
   * task keys on. `buildWithoutBroadcast` is unconditionally true because
   * `--save` without `--broadcast` is exactly a dry run.
   */
  it("advertises unconditional build-without-broadcast and resumable synthesis", () => {
    const backend = resolveDeployBackend("leo", ctxFor(leoReadyConfig()));
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
    expect(() => resolveDeployBackend("leo", ctxFor(config))).toThrow(/supports Leo 4\.3\.x only/);
  });

  it("emits compatibility warnings and still returns a usable backend", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The warning is provider-scoped: the SDK path stays quiet.
      resolveDeployBackend(
        "sdk",
        ctxFor(withKeyCache({ storage: "filesystem", path: "/k/.aleo" })),
      );
      expect(warn).not.toHaveBeenCalled();

      const backend = resolveDeployBackend(
        "leo",
        ctxFor(withKeyCache({ storage: "filesystem", path: "/k/.aleo" })),
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
