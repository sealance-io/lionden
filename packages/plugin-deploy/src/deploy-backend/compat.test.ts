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

    it.each([
      "3.5.0",
      "4.0.0",
      "4.1.0",
      "4.2.0",
      "4.4.0",
      "5.0.0",
    ])("rejects leoVersion %s as outside the verified 4.3 line", (leoVersion) => {
      const config = createMockConfig({ leoVersion });
      expect(() => assertDeployBackendCompatible("leo", ctxFor(config))).toThrow(
        /supports Leo 4\.3\.x only/,
      );
    });

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

  it("throws NotImplemented for the leo provider on an otherwise valid config", () => {
    expect(() => resolveDeployBackend("leo", ctxFor(leoReadyConfig()))).toThrow(
      /not implemented yet/,
    );
  });

  /**
   * Ordering matters: a user who is both misconfigured *and* early should hear
   * about the misconfiguration, not a "not implemented" message that will still
   * be wrong once the backend ships.
   */
  it("reports a compatibility failure ahead of NotImplemented", () => {
    const config = createMockConfig({ leoVersion: "4.1.0" });
    expect(() => resolveDeployBackend("leo", ctxFor(config))).toThrow(/supports Leo 4\.3\.x only/);
  });

  it("emits compatibility warnings before returning a usable backend", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The warning is provider-scoped, so it only fires for leo — which also
      // throws. Assert the SDK path stays quiet.
      resolveDeployBackend(
        "sdk",
        ctxFor(withKeyCache({ storage: "filesystem", path: "/k/.aleo" })),
      );
      expect(warn).not.toHaveBeenCalled();

      expect(() =>
        resolveDeployBackend(
          "leo",
          ctxFor(withKeyCache({ storage: "filesystem", path: "/k/.aleo" })),
        ),
      ).toThrow();
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
