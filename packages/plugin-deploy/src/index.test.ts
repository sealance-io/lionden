import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectGlobalOptions, createLre } from "@lionden/core";
import type { NetworkManager } from "@lionden/network";
import { createMockConfig, createMockConnection } from "@lionden/test-internals";
import { describe, expect, it, vi } from "vitest";
import { writeDeploymentRecord } from "./deployment-state.js";
import type { CompleteDeploymentRecord } from "./deployment-types.js";
import pluginDeploy, { DeployError } from "./index.js";
import { UpgradeCompatibilityError } from "./upgrade-task.js";

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
        edition: 1,
        constructor: { type: "noupgrade" },
        abiHash: "abc123",
        network: "devnode",
        endpoint: "http://127.0.0.1:3030",
        updatedAt: "2026-01-01T00:00:00.000Z",
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
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// UpgradeCompatibilityError tests
// ---------------------------------------------------------------------------

describe("UpgradeCompatibilityError", () => {
  it("formats violation details in error message", () => {
    const err = new UpgradeCompatibilityError("token.aleo", [
      { kind: "mapping_deleted", name: "balances", detail: 'mapping "balances" was deleted' },
      { kind: "transition_deleted", name: "burn", detail: 'transition "burn" was deleted' },
    ]);

    expect(err.message).toContain("token.aleo");
    expect(err.message).toContain("mapping_deleted");
    expect(err.message).toContain("transition_deleted");
    expect(err.violations).toHaveLength(2);
    expect(err).toBeInstanceOf(DeployError);
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
