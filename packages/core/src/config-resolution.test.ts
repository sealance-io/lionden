import { describe, it, expect, vi } from "vitest";
import { resolveConfig, ConfigResolutionError } from "./config-resolution.js";
import type { LionDenUserConfig } from "@lionden/config";
import { configVariable } from "@lionden/config";
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
    expect(resolved.skipLeoVersionCheck).toBe(false);
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
    expect(resolved.sdk.keyCache).toEqual({
      storage: "filesystem",
      path: "/tmp/test-project/artifacts/.cache/provable-keys/.aleo",
    });
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

  it("rejects unknown network types", async () => {
    const config = {
      networks: {
        local: { type: "devnet" },
      },
    } as unknown as LionDenUserConfig;
    await expect(resolve(config, [], projectRoot)).rejects.toThrow(
      /Unknown network type "devnet"/,
    );
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

  it("resolves filesystem SDK key cache path under artifacts by default", async () => {
    const resolved = await resolve(
      { sdk: { keyCache: { storage: "filesystem" } } },
      [],
      projectRoot,
    );

    expect(resolved.sdk.keyCache).toEqual({
      storage: "filesystem",
      path: "/tmp/test-project/artifacts/.cache/provable-keys/.aleo",
    });
  });

  it("allows opting out of filesystem SDK key caching", async () => {
    const resolved = await resolve(
      { sdk: { keyCache: { storage: "memory" } } },
      [],
      projectRoot,
    );

    expect(resolved.sdk.keyCache).toEqual({ storage: "memory" });
  });

  it("does not retain the default filesystem path when a plugin resolves memory SDK key caching", async () => {
    const plugin: LionDenPlugin = {
      id: "memory-sdk-cache-plugin",
      hookHandlers: {
        config: {
          resolveConfig: () => ({
            sdk: { keyCache: { storage: "memory" } },
          }),
        },
      },
    };

    const { resolved } = await resolveConfig({}, [plugin], projectRoot);
    expect(resolved.sdk.keyCache).toEqual({ storage: "memory" });
  });

  it("normalizes filesystem SDK key cache paths to a .aleo directory", async () => {
    const resolved = await resolve(
      { sdk: { keyCache: { storage: "filesystem", path: "cache/provable" } } },
      [],
      projectRoot,
    );

    expect(resolved.sdk.keyCache.path).toBe("/tmp/test-project/cache/provable/.aleo");
  });

  it("does not append .aleo twice for filesystem SDK key cache paths", async () => {
    const resolved = await resolve(
      { sdk: { keyCache: { storage: "filesystem", path: "cache/provable/.aleo" } } },
      [],
      projectRoot,
    );

    expect(resolved.sdk.keyCache.path).toBe("/tmp/test-project/cache/provable/.aleo");
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

  it("resolves devnode account ConfigVariables to strings", async () => {
    // Set env var for the config variable
    process.env["TEST_ALEO_KEY"] = "APrivateKey1zkpResolved123";
    try {
      const config: LionDenUserConfig = {
        networks: {
          local: {
            type: "devnode",
            accounts: [
              { privateKey: configVariable("TEST_ALEO_KEY"), name: "deployer" },
              { privateKey: "APrivateKey1zkpLiteral456" },
            ],
          },
        },
      };
      const resolved = await resolve(config, [], projectRoot);
      const net = resolved.networks["local"]!;
      if (net.type === "devnode") {
        expect(net.accounts).toHaveLength(2);
        // ConfigVariable should be resolved to the env var value
        expect(net.accounts[0]!.privateKey).toBe("APrivateKey1zkpResolved123");
        expect(net.accounts[0]!.name).toBe("deployer");
        // Literal string passes through unchanged
        expect(net.accounts[1]!.privateKey).toBe("APrivateKey1zkpLiteral456");
      }
    } finally {
      delete process.env["TEST_ALEO_KEY"];
    }
  });

  it("throws on unresolvable devnode account private key", async () => {
    const config: LionDenUserConfig = {
      networks: {
        local: {
          type: "devnode",
          accounts: [
            { privateKey: configVariable("NONEXISTENT_VAR_FOR_TEST") },
          ],
        },
      },
    };
    await expect(resolve(config, [], projectRoot)).rejects.toThrow(
      "NONEXISTENT_VAR_FOR_TEST",
    );
  });

  it("defaults leoBinary to 'leo'", async () => {
    const resolved = await resolve({}, [], projectRoot);
    expect(resolved.leoBinary).toBe("leo");
  });

  it("defaults skipLeoVersionCheck to false", async () => {
    const resolved = await resolve({}, [], projectRoot);
    expect(resolved.skipLeoVersionCheck).toBe(false);
  });

  it("respects user-specified skipLeoVersionCheck", async () => {
    const resolved = await resolve({ skipLeoVersionCheck: true }, [], projectRoot);
    expect(resolved.skipLeoVersionCheck).toBe(true);
  });

  it("respects user-specified leoBinary", async () => {
    const resolved = await resolve({ leoBinary: "/usr/local/bin/leo-3.5" }, [], projectRoot);
    expect(resolved.leoBinary).toBe("/usr/local/bin/leo-3.5");
  });

  it("expands tilde in leoBinary", async () => {
    const resolved = await resolve({ leoBinary: "~/.leo/bin/leo-3.5" }, [], projectRoot);
    expect(resolved.leoBinary).not.toContain("~");
    expect(resolved.leoBinary).toMatch(/\.leo\/bin\/leo-3\.5$/);
  });

  it("passes explicit consensusHeights through devnode network config", async () => {
    const config: LionDenUserConfig = {
      networks: {
        local: { type: "devnode", consensusHeights: "0,1,2" },
      },
    };
    const resolved = await resolve(config, [], projectRoot);
    const net = resolved.networks["local"]!;
    if (net.type === "devnode") {
      expect(net.consensusHeights).toBe("0,1,2");
    }
  });

  it("leaves consensusHeights undefined when not set on explicit devnode", async () => {
    const config: LionDenUserConfig = {
      networks: { local: { type: "devnode" } },
    };
    const resolved = await resolve(config, [], projectRoot);
    const net = resolved.networks["local"]!;
    if (net.type === "devnode") {
      expect(net.consensusHeights).toBeUndefined();
    }
  });

  it("leaves consensusHeights undefined on implicit default devnode", async () => {
    const resolved = await resolve({}, [], projectRoot);
    const net = resolved.networks["devnode"]!;
    if (net.type === "devnode") {
      expect(net.consensusHeights).toBeUndefined();
    }
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

  it("codegen.dynamicRecords defaults to an empty object", async () => {
    const resolved = await resolve({}, [], projectRoot);
    expect(resolved.codegen.dynamicRecords).toEqual({});
  });

  it("codegen.dynamicRecords attaches helperName to each entry", async () => {
    const resolved = await resolve(
      {
        codegen: {
          dynamicRecords: {
            asPoolToken: {
              sourceRecord: "Token",
              schema: { owner: "address.private" },
            },
          },
        },
      },
      [],
      projectRoot,
    );
    expect(resolved.codegen.dynamicRecords).toEqual({
      asPoolToken: {
        helperName: "asPoolToken",
        sourceRecord: "Token",
        schema: { owner: "address.private" },
      },
    });
  });

  it("codegen.dynamicRecords carries sourceProgram when present", async () => {
    const resolved = await resolve(
      {
        codegen: {
          dynamicRecords: {
            asPoolToken: {
              sourceRecord: "Token",
              sourceProgram: "stable_token.aleo",
              schema: { owner: "address.private" },
            },
          },
        },
      },
      [],
      projectRoot,
    );
    expect(resolved.codegen.dynamicRecords["asPoolToken"]).toMatchObject({
      helperName: "asPoolToken",
      sourceProgram: "stable_token.aleo",
    });
  });

  it("codegen.dynamicRecords drops malformed entries defensively (validation lives in plugin-leo)", async () => {
    // Core normalization stays defensive: it must not throw on malformed input.
    // The plugin-leo validateUserConfig hook surfaces these as
    // ConfigValidationError before this normalization step in the normal flow,
    // but if validation isn't installed (test setups, custom plugin stacks)
    // we want the resolved value to be safe to consume.
    const resolved = await resolve(
      {
        codegen: {
          // Mix valid + malformed entries
          dynamicRecords: {
            good: {
              sourceRecord: "Token",
              schema: { owner: "address.private" },
            },
            // malformed: missing schema
            broken1: { sourceRecord: "Token" } as any,
            // malformed: schema is array
            broken2: { sourceRecord: "Token", schema: ["x"] } as any,
            // malformed: non-string sourceRecord
            broken3: { sourceRecord: 42, schema: {} } as any,
          },
        },
      },
      [],
      projectRoot,
    );
    expect(Object.keys(resolved.codegen.dynamicRecords)).toEqual(["good"]);
  });
});

// ---------------------------------------------------------------------------
// namedAccounts resolution
// ---------------------------------------------------------------------------

describe("resolveNamedAccountsConfig", () => {
  const root = "/tmp/test-project";

  it("returns empty record when namedAccounts is not configured", async () => {
    const resolved = await resolve({}, [], root);
    expect(resolved.namedAccounts).toEqual({});
  });

  it("resolves a numeric index to { type: 'index' }", async () => {
    const resolved = await resolve(
      { namedAccounts: { deployer: { default: 0 } } },
      [],
      root,
    );
    expect(resolved.namedAccounts["deployer"]).toEqual({
      networks: {},
      default: { type: "index", index: 0 },
    });
  });

  it("resolves a valid aleo1 address to { type: 'address' }", async () => {
    const addr = "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5";
    const resolved = await resolve(
      { namedAccounts: { treasury: { default: addr } } },
      [],
      root,
    );
    expect(resolved.namedAccounts["treasury"]).toEqual({
      networks: {},
      default: { type: "address", address: addr },
    });
  });

  it("resolves an APrivateKey1 string to { type: 'privateKey' }", async () => {
    const key = "APrivateKey1zkpFakeKey123456789";
    const resolved = await resolve(
      { namedAccounts: { deployer: { default: key } } },
      [],
      root,
    );
    expect(resolved.namedAccounts["deployer"]).toEqual({
      networks: {},
      default: { type: "privateKey", privateKey: key },
    });
  });

  it("resolves per-network overrides alongside default", async () => {
    const resolved = await resolve(
      {
        namedAccounts: {
          deployer: {
            default: 0,
            testnet: "APrivateKey1zkpTestnetKey",
          },
        },
      },
      [],
      root,
    );
    expect(resolved.namedAccounts["deployer"]).toEqual({
      networks: { testnet: { type: "privateKey", privateKey: "APrivateKey1zkpTestnetKey" } },
      default: { type: "index", index: 0 },
    });
  });

  it("resolves a ConfigVariable by reading the env var", async () => {
    process.env["TEST_NAMED_KEY"] = "APrivateKey1zkpFromEnv";
    try {
      const resolved = await resolve(
        {
          namedAccounts: {
            deployer: { default: configVariable("TEST_NAMED_KEY") },
          },
        },
        [],
        root,
      );
      expect(resolved.namedAccounts["deployer"]!.default).toEqual({
        type: "privateKey",
        privateKey: "APrivateKey1zkpFromEnv",
      });
    } finally {
      delete process.env["TEST_NAMED_KEY"];
    }
  });

  it("throws ConfigResolutionError for a negative index", async () => {
    await expect(
      resolve({ namedAccounts: { deployer: { default: -1 } } }, [], root),
    ).rejects.toThrow(ConfigResolutionError);
  });

  it("throws ConfigResolutionError for a non-integer index", async () => {
    await expect(
      resolve({ namedAccounts: { deployer: { default: 1.5 } } }, [], root),
    ).rejects.toThrow(ConfigResolutionError);
  });

  it("throws ConfigResolutionError for NaN index", async () => {
    await expect(
      resolve({ namedAccounts: { deployer: { default: NaN } } }, [], root),
    ).rejects.toThrow(ConfigResolutionError);
  });

  it("throws ConfigResolutionError for an aleo1 string with invalid shape (too short)", async () => {
    await expect(
      resolve({ namedAccounts: { treasury: { default: "aleo1short" } } }, [], root),
    ).rejects.toThrow(ConfigResolutionError);
  });

  it("throws ConfigResolutionError for an aleo1 string with invalid characters", async () => {
    const bad = "aleo1INVALID!chars" + "a".repeat(45);
    await expect(
      resolve({ namedAccounts: { treasury: { default: bad } } }, [], root),
    ).rejects.toThrow(ConfigResolutionError);
  });

  it("throws ConfigResolutionError for an unrecognized string", async () => {
    await expect(
      resolve({ namedAccounts: { mystery: { default: "not-an-address-or-key" } } }, [], root),
    ).rejects.toThrow(ConfigResolutionError);
  });
});
