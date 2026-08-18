import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LionDenResolvedConfig } from "@lionden/config";
import {
  ArgumentType,
  type ConfigValidationError,
  collectGlobalOptions,
  createLre,
} from "@lionden/core";
import type { NetworkManager } from "@lionden/network";
import { createMockConfig, createMockConnection } from "@lionden/test-internals";
import { describe, expect, it, vi } from "vitest";
import { writeDeploymentRecord } from "./deployment-state.js";
import type { CompleteDeploymentRecord } from "./deployment-types.js";
import pluginDeploy from "./index.js";

const mockConfig = createMockConfig();

// ---------------------------------------------------------------------------
// Plugin structure tests
// ---------------------------------------------------------------------------

describe("plugin-deploy", () => {
  it("has correct plugin id and name", () => {
    expect(pluginDeploy.id).toBe("@lionden/plugin-deploy");
    expect(pluginDeploy.name).toBe("Deploy Plugin");
  });

  it("registers deploy, upgrade, and export tasks", () => {
    const taskIds = pluginDeploy.tasks?.map((t) => t.id) ?? [];
    expect(taskIds).toContain("deploy");
    expect(taskIds).toContain("upgrade");
    expect(taskIds).toContain("export");
  });

  it("has config hook handlers", () => {
    expect(pluginDeploy.hookHandlers).toBeDefined();
    expect(pluginDeploy.hookHandlers!.config).toBeDefined();
  });

  it("does not register a plugin-global prove (--prove is a framework built-in)", () => {
    const prove = pluginDeploy.globalOptions?.find((o) => o.name === "prove");
    expect(prove).toBeUndefined();

    // collectGlobalOptions must not surface prove from this plugin — it is a
    // reserved built-in global; resolveProveOption reads lre.globalOptions.
    const collected = collectGlobalOptions([pluginDeploy]);
    expect(collected.has("prove")).toBe(false);
  });

  it("deploy task has program and priorityFee options and all flags", () => {
    const deployTask = pluginDeploy.tasks?.find((t) => t.id === "deploy");
    expect(deployTask).toBeDefined();

    const optionNames = deployTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("program");
    expect(optionNames).toContain("priorityFee");

    const flagNames = deployTask!.flags?.map((f) => f.name) ?? [];
    expect(flagNames).toContain("skipConfirm");
    expect(flagNames).toContain("dryRun");
    expect(flagNames).toContain("noSkipDeployed");
    expect(flagNames).toContain("preflight");
    expect(flagNames).toContain("export");
  });

  it("export task has out option and no task-level network option", () => {
    const exportTask = pluginDeploy.tasks?.find((t) => t.id === "export");
    expect(exportTask).toBeDefined();

    const optionNames = exportTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("out");
  });

  it("has extendLre function", () => {
    expect(pluginDeploy.extendLre).toBeDefined();
    expect(typeof pluginDeploy.extendLre).toBe("function");
  });

  it("extendLre injects lre.deployments", () => {
    const lre = createLre({
      config: mockConfig,
      plugins: [pluginDeploy],
    });
    expect(lre.deployments).not.toBeNull();
  });

  it("upgrade task has required program option", () => {
    const upgradeTask = pluginDeploy.tasks?.find((t) => t.id === "upgrade");
    expect(upgradeTask).toBeDefined();

    const programOpt = upgradeTask!.options?.find((o) => o.name === "program");
    expect(programOpt).toBeDefined();
    expect(programOpt!.required).toBe(true);
  });

  it("upgrade task has priorityFee option and skipConfirm flag", () => {
    const upgradeTask = pluginDeploy.tasks?.find((t) => t.id === "upgrade");
    expect(upgradeTask).toBeDefined();

    const optionNames = upgradeTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("priorityFee");

    const flagNames = upgradeTask!.flags?.map((f) => f.name) ?? [];
    expect(flagNames).toContain("skipConfirm");
  });

  it("registers --deploy-backend as a plugin global option, not a built-in", () => {
    const defs = collectGlobalOptions([pluginDeploy]);
    const entry = defs.get("deployBackend");
    expect(entry).toBeDefined();
    expect(entry!.definition.type).toBe(ArgumentType.STRING);
    // BUILT_IN_GLOBAL_ARGUMENT_NAMES is a *reserved* list — collectGlobalOptions
    // throws if a plugin shadows it, so registering successfully proves this is
    // not a built-in.
    expect(entry!.pluginId).toBe(pluginDeploy.id);
  });

  /**
   * `cli/src/index.ts` seeds `definition.defaultValue` into `globalOptions`
   * whenever the flag is absent. A default here would make `--deploy-backend`
   * look explicitly set on every run, which outranks — and therefore erases —
   * both config layers of the precedence ladder.
   */
  it("gives --deploy-backend no defaultValue, so config layers stay reachable", () => {
    const entry = collectGlobalOptions([pluginDeploy]).get("deployBackend");
    expect(entry!.definition.defaultValue).toBeUndefined();
  });

  it("tasks are registered in LRE", () => {
    const lre = createLre({
      config: mockConfig,
      plugins: [pluginDeploy],
    });

    expect(lre.tasks.has("deploy")).toBe(true);
    expect(lre.tasks.has("upgrade")).toBe(true);
    expect(lre.tasks.has("export")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Export task tests
// ---------------------------------------------------------------------------

describe("export task", () => {
  it("connects before exporting non-ephemeral devnode disk records", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-export-task-test-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const config = createMockConfig({
        root: tmpDir,
        networks: {
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
        defaultNetwork: "devnode",
      });
      const record: CompleteDeploymentRecord = {
        status: "complete",
        programId: "hello.aleo",
        network: "devnode",
        endpoint: "http://127.0.0.1:3030",
        updatedAt: "2026-01-01T00:00:00.000Z",
        edition: 1,
        historyCount: 1,
        txId: "at1abc",
        blockHeight: 42,
        deployerAddress: "aleo1abc",
        deployedAt: "2026-01-01T00:00:00.000Z",
      };
      writeDeploymentRecord(config.paths.deployments, "devnode", record);

      const connection = createMockConnection({
        getProgramSource: vi
          .fn()
          .mockResolvedValue("program hello.aleo;\nconstructor:\n    assert.eq edition 1u16;\n"),
        getProgramEdition: vi.fn().mockResolvedValue(1),
      });
      let activeConnection: typeof connection | null = null;
      const networkManager: NetworkManager = {
        connect: vi.fn(async () => {
          activeConnection = connection;
          return connection;
        }),
        getConnection: vi.fn(() => activeConnection),
        disconnectAll: vi.fn().mockResolvedValue(undefined),
        getAccounts: vi.fn().mockReturnValue([]),
        getNamedAccounts: vi.fn().mockReturnValue({}),
        execute: vi.fn(),
        getMappingValue: vi.fn(),
        getStorageValue: vi.fn(),
        getStorageVectorLength: vi.fn().mockResolvedValue(0),
        getStorageVectorValue: vi.fn().mockResolvedValue(null),
        waitForConfirmation: vi.fn(),
        getTransitionOutputs: vi.fn(),
      };

      const lre = createLre({ config, plugins: [pluginDeploy] });
      (lre as unknown as { network: NetworkManager }).network = networkManager;

      const bundle = (await lre.tasks.run("export")) as {
        programs: Record<string, unknown>;
      };

      expect(networkManager.connect).toHaveBeenCalledWith("devnode");
      expect(Object.keys(bundle.programs)).toEqual(["hello.aleo"]);
      expect(logSpy.mock.calls.map(([message]) => String(message))).toContain(
        'Exported 1 program for network "devnode"',
      );
      expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
        "Exported 1 programs",
      );
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Config validation hook tests
// ---------------------------------------------------------------------------

describe("config validation hooks", () => {
  it("rejects negative priority fee", () => {
    const configHooks = pluginDeploy.hookHandlers!.config;
    const validateFn = typeof configHooks === "function" ? null : configHooks;
    expect(validateFn).not.toBeNull();

    if (validateFn && "validateResolvedConfig" in validateFn) {
      const errors = validateFn.validateResolvedConfig!({
        ...mockConfig,
        deploy: { ...mockConfig.deploy, defaultPriorityFee: -1 },
      });
      const errorArray = Array.isArray(errors) ? errors : [];
      expect(errorArray.length).toBeGreaterThan(0);
      expect(errorArray[0]!.path).toBe("deploy.defaultPriorityFee");
    }
  });

  it("rejects non-positive confirmation timeout", () => {
    const configHooks = pluginDeploy.hookHandlers!.config;
    const validateFn = typeof configHooks === "function" ? null : configHooks;
    expect(validateFn).not.toBeNull();

    if (validateFn && "validateResolvedConfig" in validateFn) {
      const errors = validateFn.validateResolvedConfig!({
        ...mockConfig,
        deploy: { ...mockConfig.deploy, confirmationTimeout: 0 },
      });
      const errorArray = Array.isArray(errors) ? errors : [];
      expect(errorArray.length).toBeGreaterThan(0);
      expect(errorArray[0]!.path).toBe("deploy.confirmationTimeout");
    }
  });

  it("passes valid config", () => {
    const configHooks = pluginDeploy.hookHandlers!.config;
    const validateFn = typeof configHooks === "function" ? null : configHooks;
    expect(validateFn).not.toBeNull();

    if (validateFn && "validateResolvedConfig" in validateFn) {
      const errors = validateFn.validateResolvedConfig!(mockConfig);
      const errorArray = Array.isArray(errors) ? errors : [];
      expect(errorArray).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Deploy-backend config validation
//
// This hook covers only what is unconditionally decidable from resolved config.
// Whether the *effective* backend is compatible with the rest of the config
// depends on --deploy-backend and LIONDEN_DEPLOY_BACKEND, neither of which
// exists yet at config-resolution time — that is assertDeployBackendCompatible,
// covered in deploy-backend/compat.test.ts.
// ---------------------------------------------------------------------------

describe("deploy-backend config validation", () => {
  /** Unwraps the hook without the surrounding tests' vacuous-if pattern. */
  function validate(config: LionDenResolvedConfig): ConfigValidationError[] {
    const configHooks = pluginDeploy.hookHandlers!.config;
    if (typeof configHooks === "function" || !configHooks?.validateResolvedConfig) {
      throw new Error("plugin-deploy no longer registers a validateResolvedConfig hook");
    }
    const errors = configHooks.validateResolvedConfig(config);
    if (!Array.isArray(errors)) throw new Error("expected a synchronous ConfigValidationError[]");
    return errors;
  }

  function withDeploy(deploy: Record<string, unknown>): LionDenResolvedConfig {
    return { ...mockConfig, deploy: { ...mockConfig.deploy, ...deploy } } as LionDenResolvedConfig;
  }

  it("accepts both known providers", () => {
    expect(validate(withDeploy({ backend: "sdk" }))).toHaveLength(0);
    expect(validate(withDeploy({ backend: "leo" }))).toHaveLength(0);
  });

  it("rejects an unknown deploy.backend", () => {
    const errors = validate(withDeploy({ backend: "provable" }));
    expect(errors.map((e) => e.path)).toContain("deploy.backend");
  });

  it("rejects an unknown per-network deployBackend, naming the network", () => {
    const errors = validate({
      ...mockConfig,
      networks: {
        devnode: { ...mockConfig.networks["devnode"]!, deployBackend: "leocli" },
      },
    } as unknown as LionDenResolvedConfig);
    expect(errors.map((e) => e.path)).toContain("networks.devnode.deployBackend");
  });

  it("accepts a network that sets no deployBackend at all", () => {
    expect(validate(mockConfig)).toHaveLength(0);
  });

  it("rejects a negative Leo timeout but accepts 0 as 'disabled'", () => {
    expect(validate(withDeploy({ leo: { timeout: -1, logMode: "forward" } })).map((e) => e.path)) //
      .toContain("deploy.leo.timeout");
    expect(validate(withDeploy({ leo: { timeout: 0, logMode: "forward" } }))).toHaveLength(0);
  });

  it("rejects an unknown log mode", () => {
    const errors = validate(withDeploy({ leo: { timeout: 1000, logMode: "buffered" } }));
    expect(errors.map((e) => e.path)).toContain("deploy.leo.logMode");
  });

  /**
   * "inherit" is the mode a user is most likely to reach for, and the reason it
   * is absent is not guessable — the error has to say it.
   */
  it("explains why logMode 'inherit' is unsupported", () => {
    const errors = validate(withDeploy({ leo: { timeout: 1000, logMode: "inherit" } }));
    const logModeError = errors.find((e) => e.path === "deploy.leo.logMode");
    expect(logModeError?.message).toMatch(/redacted/);
  });
});
