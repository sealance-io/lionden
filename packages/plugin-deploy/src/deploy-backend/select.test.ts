/**
 * The deploy-backend precedence ladder.
 *
 * Each layer gets a test that sets it *and* a lower-priority layer to the
 * opposite value, so a test can only pass if the ordering is right — asserting
 * a layer in isolation would still pass if the resolver ignored it and fell
 * through to a default that happened to match.
 */

import type { LionDenResolvedConfig, LionDenUserConfig } from "@lionden/config";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import { createMockConfig } from "@lionden/test-internals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeployError } from "../errors.js";
import {
  DEPLOY_BACKEND_ENV_VAR,
  resolveDeployBackendFromEnvAndConfig,
  resolveDeployBackendOption,
} from "./select.js";

type DeployOverrides = NonNullable<LionDenUserConfig["deploy"]>;

function makeConfig(
  deploy: Partial<Pick<DeployOverrides, "backend">> = {},
  networkDeployBackend?: unknown,
): LionDenResolvedConfig {
  const base = createMockConfig();
  return createMockConfig({
    deploy: { ...base.deploy, ...deploy },
    networks: {
      devnode: {
        ...base.networks["devnode"]!,
        ...(networkDeployBackend !== undefined
          ? { deployBackend: networkDeployBackend as "sdk" | "leo" }
          : {}),
      },
    },
  });
}

function makeLre(
  config: LionDenResolvedConfig,
  globalOptions: Record<string, unknown> = {},
): LionDenRuntimeEnvironment {
  return { config, globalOptions } as LionDenRuntimeEnvironment;
}

describe("resolveDeployBackendOption", () => {
  const originalEnv = process.env[DEPLOY_BACKEND_ENV_VAR];

  beforeEach(() => {
    delete process.env[DEPLOY_BACKEND_ENV_VAR];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[DEPLOY_BACKEND_ENV_VAR];
    else process.env[DEPLOY_BACKEND_ENV_VAR] = originalEnv;
  });

  it('defaults to "sdk" when nothing selects a backend', () => {
    expect(resolveDeployBackendOption({}, makeLre(makeConfig()), "devnode")).toBe("sdk");
  });

  it("prefers an explicit argument over every other layer", () => {
    const config = makeConfig({ backend: "sdk" }, "sdk");
    process.env[DEPLOY_BACKEND_ENV_VAR] = "sdk";
    const lre = makeLre(config, { deployBackend: "sdk" });
    expect(resolveDeployBackendOption({ deployBackend: "leo" }, lre, "devnode")).toBe("leo");
  });

  it("prefers --deploy-backend over the env var and both config layers", () => {
    const config = makeConfig({ backend: "sdk" }, "sdk");
    process.env[DEPLOY_BACKEND_ENV_VAR] = "sdk";
    const lre = makeLre(config, { deployBackend: "leo" });
    expect(resolveDeployBackendOption({}, lre, "devnode")).toBe("leo");
  });

  it("prefers the env var over both config layers", () => {
    process.env[DEPLOY_BACKEND_ENV_VAR] = "leo";
    const config = makeConfig({ backend: "sdk" }, "sdk");
    expect(resolveDeployBackendOption({}, makeLre(config), "devnode")).toBe("leo");
  });

  it("prefers the per-network override over deploy.backend", () => {
    const config = makeConfig({ backend: "sdk" }, "leo");
    expect(resolveDeployBackendOption({}, makeLre(config), "devnode")).toBe("leo");
  });

  /**
   * The inverse direction — this is the case that only works because
   * `resolveNetworkConfig` conditionally spreads `deployBackend`.
   */
  it("lets an explicit per-network sdk beat a project-wide leo", () => {
    const config = makeConfig({ backend: "leo" }, "sdk");
    expect(resolveDeployBackendOption({}, makeLre(config), "devnode")).toBe("sdk");
  });

  it("falls back to deploy.backend when the network sets nothing", () => {
    const config = makeConfig({ backend: "leo" });
    expect(resolveDeployBackendOption({}, makeLre(config), "devnode")).toBe("leo");
  });

  it("falls through an unknown network name to deploy.backend", () => {
    const config = makeConfig({ backend: "leo" });
    expect(resolveDeployBackendOption({}, makeLre(config), "nope")).toBe("leo");
  });

  describe("rejects unrecognized values rather than falling through", () => {
    it("from the argument", () => {
      const lre = makeLre(makeConfig());
      expect(() => resolveDeployBackendOption({ deployBackend: "Leo" }, lre, "devnode")).toThrow(
        DeployError,
      );
    });

    it("from --deploy-backend", () => {
      const lre = makeLre(makeConfig(), { deployBackend: "provable" });
      expect(() => resolveDeployBackendOption({}, lre, "devnode")).toThrow(/--deploy-backend/);
    });

    it("from the env var", () => {
      process.env[DEPLOY_BACKEND_ENV_VAR] = "LEO";
      const lre = makeLre(makeConfig());
      expect(() => resolveDeployBackendOption({}, lre, "devnode")).toThrow(
        new RegExp(DEPLOY_BACKEND_ENV_VAR),
      );
    });

    it("from the per-network override", () => {
      const lre = makeLre(makeConfig({}, "leocli"));
      expect(() => resolveDeployBackendOption({}, lre, "devnode")).toThrow(
        /networks\.devnode\.deployBackend/,
      );
    });

    it("from deploy.backend", () => {
      const lre = makeLre(makeConfig({ backend: "sdkk" as "sdk" }));
      expect(() => resolveDeployBackendOption({}, lre, "devnode")).toThrow(/deploy\.backend/);
    });
  });

  /**
   * An empty value is *present*, so on every layer a user can type it directly
   * it has to fail rather than fall through — `--deploy-backend=` must not
   * quietly select the SDK.
   */
  describe("empty values", () => {
    it("rejects an empty argument", () => {
      const lre = makeLre(makeConfig({ backend: "leo" }));
      expect(() => resolveDeployBackendOption({ deployBackend: "" }, lre, "devnode")).toThrow(
        /empty value/,
      );
    });

    it("rejects an empty --deploy-backend", () => {
      const lre = makeLre(makeConfig({ backend: "leo" }), { deployBackend: "" });
      expect(() => resolveDeployBackendOption({}, lre, "devnode")).toThrow(/empty value/);
    });

    it("rejects an empty per-network override", () => {
      const lre = makeLre(makeConfig({ backend: "leo" }, ""));
      expect(() => resolveDeployBackendOption({}, lre, "devnode")).toThrow(
        /networks\.devnode\.deployBackend/,
      );
    });

    it("rejects an empty deploy.backend", () => {
      const lre = makeLre(makeConfig({ backend: "" as "sdk" }));
      expect(() => resolveDeployBackendOption({}, lre, "devnode")).toThrow(/deploy\.backend/);
    });

    /**
     * The one exemption. `FOO=` is an ordinary way to clear a shell variable,
     * and `parseBooleanEnv` already reads an empty env value as unset.
     */
    it("treats an empty env var as unset, matching parseBooleanEnv", () => {
      process.env[DEPLOY_BACKEND_ENV_VAR] = "";
      const lre = makeLre(makeConfig({ backend: "leo" }));
      expect(resolveDeployBackendOption({}, lre, "devnode")).toBe("leo");
    });
  });

  it("rejects null rather than treating it as unset", () => {
    const lre = makeLre(makeConfig({ backend: "leo" }));
    expect(() => resolveDeployBackendOption({ deployBackend: null }, lre, "devnode")).toThrow(
      DeployError,
    );
  });
});

describe("resolveDeployBackendFromEnvAndConfig", () => {
  const originalEnv = process.env[DEPLOY_BACKEND_ENV_VAR];

  beforeEach(() => {
    delete process.env[DEPLOY_BACKEND_ENV_VAR];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[DEPLOY_BACKEND_ENV_VAR];
    else process.env[DEPLOY_BACKEND_ENV_VAR] = originalEnv;
  });

  it("honors the env var above both config layers", () => {
    process.env[DEPLOY_BACKEND_ENV_VAR] = "leo";
    expect(resolveDeployBackendFromEnvAndConfig(makeConfig({ backend: "sdk" }), "devnode")).toBe(
      "leo",
    );
  });

  it("keeps the same config ordering as the full ladder", () => {
    expect(
      resolveDeployBackendFromEnvAndConfig(makeConfig({ backend: "leo" }, "sdk"), "devnode"),
    ).toBe("sdk");
  });
});
