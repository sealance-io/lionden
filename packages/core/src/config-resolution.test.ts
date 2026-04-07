import { describe, it, expect, vi } from "vitest";
import { resolveConfig, ConfigResolutionError } from "./config-resolution.js";
import type { LionDenUserConfig } from "@lionden/config";
import type { LionDenPlugin } from "./types.js";

/** Helper to unwrap the resolved config from the result tuple */
async function resolve(
  config: LionDenUserConfig,
  plugins: readonly LionDenPlugin[],
  root: string,
) {
  const result = await resolveConfig(config, plugins, root);
  return result.resolved;
}

describe("resolveConfig", () => {
  const projectRoot = "/tmp/test-project";

  it("fills all defaults for empty config", async () => {
    const resolved = await resolve({}, [], projectRoot);

    expect(resolved.leoVersion).toBe("4.0.0");
    expect(resolved.defaultNetwork).toBe("devnode");
    expect(resolved.paths.root).toBe(projectRoot);
    expect(resolved.paths.programs).toBe("/tmp/test-project/programs");
    expect(resolved.paths.artifacts).toBe("/tmp/test-project/artifacts");
    expect(resolved.paths.typechain).toBe("/tmp/test-project/typechain");
    expect(resolved.paths.cache).toBe("/tmp/test-project/artifacts/.cache");
    expect(resolved.compiler.enableDce).toBe(true);
    expect(resolved.compiler.conditionalBlockMaxDepth).toBe(10);
    expect(resolved.codegen.enabled).toBe(true);
    expect(resolved.testing.timeout).toBe(120_000);
    expect(resolved.testing.autoStartDevnode).toBe(true);
    expect(resolved.deploy.defaultPriorityFee).toBe(0);
    expect(resolved.deploy.confirmTransactions).toBe(true);
  });

  it("provides a default devnode network", async () => {
    const resolved = await resolve({}, [], projectRoot);
    expect(resolved.networks["devnode"]).toBeDefined();
    expect(resolved.networks["devnode"]!.type).toBe("devnode");
  });

  it("resolves devnode network config with defaults", async () => {
    const config: LionDenUserConfig = {
      networks: {
        local: { type: "devnode" },
      },
    };
    const resolved = await resolve(config, [], projectRoot);
    const net = resolved.networks["local"]!;
    expect(net.type).toBe("devnode");
    if (net.type === "devnode") {
      expect(net.socketAddr).toBe("127.0.0.1:3030");
      expect(net.autoBlock).toBe(true);
      expect(net.network).toBe("testnet");
    }
  });

  it("resolves devnet network config with defaults", async () => {
    const config: LionDenUserConfig = {
      networks: {
        local: { type: "devnet" },
      },
    };
    const resolved = await resolve(config, [], projectRoot);
    const net = resolved.networks["local"]!;
    if (net.type === "devnet") {
      expect(net.numValidators).toBe(4);
      expect(net.numClients).toBe(2);
      expect(net.snarkosPath).toBe("snarkos");
    }
  });

  it("resolves http network config", async () => {
    const config: LionDenUserConfig = {
      networks: {
        testnet: {
          type: "http",
          endpoint: "https://api.example.com",
          network: "testnet",
        },
      },
    };
    const resolved = await resolve(config, [], projectRoot);
    const net = resolved.networks["testnet"]!;
    if (net.type === "http") {
      expect(net.endpoint).toBe("https://api.example.com");
      expect(net.network).toBe("testnet");
    }
  });

  it("respects user-specified paths", async () => {
    const config: LionDenUserConfig = {
      programsDir: "src/programs",
      artifactsDir: "build",
      typechainDir: "generated",
    };
    const resolved = await resolve(config, [], projectRoot);
    expect(resolved.paths.programs).toBe("/tmp/test-project/src/programs");
    expect(resolved.paths.artifacts).toBe("/tmp/test-project/build");
    expect(resolved.paths.typechain).toBe("/tmp/test-project/generated");
  });

  it("respects user-specified compiler settings", async () => {
    const config: LionDenUserConfig = {
      compiler: {
        enableDce: false,
        conditionalBlockMaxDepth: 20,
        buildTests: true,
        extraFlags: ["--flag1"],
      },
    };
    const resolved = await resolve(config, [], projectRoot);
    expect(resolved.compiler.enableDce).toBe(false);
    expect(resolved.compiler.conditionalBlockMaxDepth).toBe(20);
    expect(resolved.compiler.buildTests).toBe(true);
    expect(resolved.compiler.extraFlags).toEqual(["--flag1"]);
  });

  it("runs validateUserConfig hooks and throws on errors", async () => {
    const plugin: LionDenPlugin = {
      id: "validator-plugin",
      hookHandlers: {
        config: {
          validateUserConfig: () => [
            { path: "leoVersion", message: "unsupported version" },
          ],
        },
      },
    };

    await expect(
      resolveConfig({ leoVersion: "3.0.0" }, [plugin], projectRoot),
    ).rejects.toThrow(ConfigResolutionError);
  });

  it("runs validateResolvedConfig hooks and throws on errors", async () => {
    const plugin: LionDenPlugin = {
      id: "resolved-validator",
      hookHandlers: {
        config: {
          validateResolvedConfig: (config) => {
            if (config.defaultNetwork === "devnode") {
              return [{ path: "defaultNetwork", message: "devnode not allowed" }];
            }
            return [];
          },
        },
      },
    };

    await expect(
      resolveConfig({}, [plugin], projectRoot),
    ).rejects.toThrow("devnode not allowed");
  });

  it("runs extendUserConfig hooks to transform config", async () => {
    const plugin: LionDenPlugin = {
      id: "extender-plugin",
      hookHandlers: {
        config: {
          extendUserConfig: (config) => ({
            ...config,
            leoVersion: "4.1.0",
          }),
        },
      },
    };

    const { resolved } = await resolveConfig({}, [plugin], projectRoot);
    expect(resolved.leoVersion).toBe("4.1.0");
  });

  it("succeeds when validation hooks return no errors", async () => {
    const plugin: LionDenPlugin = {
      id: "ok-validator",
      hookHandlers: {
        config: {
          validateUserConfig: () => [],
          validateResolvedConfig: () => [],
        },
      },
    };

    const { resolved } = await resolveConfig({}, [plugin], projectRoot);
    expect(resolved.leoVersion).toBe("4.0.0");
  });

  it("calls lazy config hook factory only once across all stages", async () => {
    const factory = vi.fn(async () => ({
      extendUserConfig: (c: LionDenUserConfig) => c,
      validateUserConfig: () => [],
      validateResolvedConfig: () => [],
    }));

    const plugin: LionDenPlugin = {
      id: "lazy-plugin",
      hookHandlers: { config: factory },
    };

    await resolveConfig({}, [plugin], projectRoot);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("returns extendedUserConfig reflecting plugin mutations", async () => {
    const plugin: LionDenPlugin = {
      id: "task-injector",
      hookHandlers: {
        config: {
          extendUserConfig: (config) => ({
            ...config,
            leoVersion: "4.2.0",
          }),
        },
      },
    };

    const { extendedUserConfig } = await resolveConfig({}, [plugin], projectRoot);
    expect(extendedUserConfig.leoVersion).toBe("4.2.0");
  });

  it("resolves paths.typechain from codegen.outDir when set", async () => {
    const config: LionDenUserConfig = {
      codegen: { outDir: "generated" },
    };
    const resolved = await resolve(config, [], projectRoot);

    // paths.typechain should follow codegen.outDir
    expect(resolved.paths.typechain).toBe("/tmp/test-project/generated");
    expect(resolved.codegen.outDir).toBe("generated");
  });

  it("uses typechainDir as default for paths.typechain and codegen.outDir", async () => {
    const config: LionDenUserConfig = {
      typechainDir: "custom-types",
    };
    const resolved = await resolve(config, [], projectRoot);

    expect(resolved.paths.typechain).toBe("/tmp/test-project/custom-types");
    expect(resolved.codegen.outDir).toBe("custom-types");
  });

  it("codegen.outDir takes precedence over typechainDir", async () => {
    const config: LionDenUserConfig = {
      typechainDir: "old-path",
      codegen: { outDir: "new-path" },
    };
    const resolved = await resolve(config, [], projectRoot);

    expect(resolved.paths.typechain).toBe("/tmp/test-project/new-path");
    expect(resolved.codegen.outDir).toBe("new-path");
  });
});
