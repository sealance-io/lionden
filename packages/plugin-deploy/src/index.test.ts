import { ArgumentType, collectGlobalOptions, createLre } from "@lionden/core";
import { createMockConfig } from "@lionden/test-internals";
import { describe, expect, it } from "vitest";
import { DeployError, validateConstructor } from "./deploy-task.js";
import type { CompleteDeploymentRecord } from "./deployment-types.js";
import pluginDeploy from "./index.js";
import { UpgradeCompatibilityError, validateUpgradePermission } from "./upgrade-task.js";

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

  it("registers --prove as a BOOLEAN global option", () => {
    const prove = pluginDeploy.globalOptions?.find((o) => o.name === "prove");
    expect(prove).toBeDefined();
    expect(prove!.type).toBe(ArgumentType.BOOLEAN);

    // collectGlobalOptions surfaces it without collisions in the standard stack.
    const collected = collectGlobalOptions([pluginDeploy]);
    expect(collected.has("prove")).toBe(true);
    expect(collected.get("prove")!.pluginId).toBe("@lionden/plugin-deploy");
  });

  it("deploy task has program, priorityFee, network options and all flags", () => {
    const deployTask = pluginDeploy.tasks?.find((t) => t.id === "deploy");
    expect(deployTask).toBeDefined();

    const optionNames = deployTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("program");
    expect(optionNames).toContain("priorityFee");
    expect(optionNames).toContain("network");

    const flagNames = deployTask!.flags?.map((f) => f.name) ?? [];
    expect(flagNames).toContain("skipConfirm");
    expect(flagNames).toContain("dryRun");
    expect(flagNames).toContain("noSkipDeployed");
    expect(flagNames).toContain("preflight");
    expect(flagNames).toContain("export");
  });

  it("export task has network and out options", () => {
    const exportTask = pluginDeploy.tasks?.find((t) => t.id === "export");
    expect(exportTask).toBeDefined();

    const optionNames = exportTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("network");
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

  it("upgrade task has priorityFee, network options and skipConfirm flag", () => {
    const upgradeTask = pluginDeploy.tasks?.find((t) => t.id === "upgrade");
    expect(upgradeTask).toBeDefined();

    const optionNames = upgradeTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("priorityFee");
    expect(optionNames).toContain("network");

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
// Constructor validation tests
// ---------------------------------------------------------------------------

describe("validateConstructor", () => {
  it("throws DeployError when constructor is null", () => {
    expect(() => validateConstructor(null, "hello.aleo")).toThrow(DeployError);
    expect(() => validateConstructor(null, "hello.aleo")).toThrow("has no constructor annotation");
  });

  it("throws DeployError with guidance including all three forms", () => {
    try {
      validateConstructor(null, "hello.aleo");
      expect.unreachable("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("@noupgrade");
      expect(msg).toContain("@admin");
      expect(msg).toContain("@custom");
    }
  });

  it("accepts @noupgrade constructor", () => {
    expect(() => validateConstructor({ type: "noupgrade" }, "hello.aleo")).not.toThrow();
  });

  it("accepts valid @admin constructor", () => {
    expect(() =>
      validateConstructor(
        {
          type: "admin",
          adminAddress: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
        },
        "token.aleo",
      ),
    ).not.toThrow();
  });

  it("throws for @admin with no address", () => {
    expect(() => validateConstructor({ type: "admin" }, "token.aleo")).toThrow(
      "no address specified",
    );
  });

  it("throws for @admin with invalid address", () => {
    expect(() =>
      validateConstructor({ type: "admin", adminAddress: "invalid_address" }, "token.aleo"),
    ).toThrow("invalid address");
  });

  it("accepts @custom constructor (warns but does not throw)", () => {
    expect(() => validateConstructor({ type: "custom" }, "dao.aleo")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Upgrade permission validation tests
// ---------------------------------------------------------------------------

describe("validateUpgradePermission", () => {
  const baseRecord: CompleteDeploymentRecord = {
    status: "complete",
    programId: "hello.aleo",
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    txId: "at1test",
    blockHeight: 42,
    edition: 0,
    constructor: { type: "noupgrade" },
    abiHash: null,
    deployerAddress: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    deployedAt: "2026-04-08T12:00:00.000Z",
    updatedAt: "2026-04-08T12:00:00.000Z",
    historyCount: 1,
  };

  it("throws for @noupgrade programs", () => {
    expect(() => validateUpgradePermission(baseRecord, "hello.aleo")).toThrow("@noupgrade");
    expect(() => validateUpgradePermission(baseRecord, "hello.aleo")).toThrow("cannot be upgraded");
  });

  it("allows @admin programs", () => {
    const record: CompleteDeploymentRecord = {
      ...baseRecord,
      constructor: {
        type: "admin",
        adminAddress: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
      },
    };
    expect(() => validateUpgradePermission(record, "hello.aleo")).not.toThrow();
  });

  it("allows @custom programs (with warning)", () => {
    const record: CompleteDeploymentRecord = {
      ...baseRecord,
      constructor: { type: "custom" },
    };
    expect(() => validateUpgradePermission(record, "hello.aleo")).not.toThrow();
  });

  it("throws for unknown constructor type", () => {
    const record: CompleteDeploymentRecord = {
      ...baseRecord,
      constructor: { type: "unknown" as any },
    };
    expect(() => validateUpgradePermission(record, "hello.aleo")).toThrow(
      "unknown constructor type",
    );
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
