import { describe, it, expect } from "vitest";
import pluginDeploy from "./index.js";
import { createLre } from "@lionden/core";
import { createMockConfig } from "@lionden/test-internals";
import { validateConstructor, DeployError } from "./deploy-task.js";
import { validateUpgradePermission, UpgradeCompatibilityError } from "./upgrade-task.js";
import type { DeployManifest } from "./deploy-manifest.js";

const mockConfig = createMockConfig();

// ---------------------------------------------------------------------------
// Plugin structure tests
// ---------------------------------------------------------------------------

describe("plugin-deploy", () => {
  it("has correct plugin id and name", () => {
    expect(pluginDeploy.id).toBe("@lionden/plugin-deploy");
    expect(pluginDeploy.name).toBe("Deploy Plugin");
  });

  it("registers deploy and upgrade tasks", () => {
    const taskIds = pluginDeploy.tasks?.map((t) => t.id) ?? [];
    expect(taskIds).toContain("deploy");
    expect(taskIds).toContain("upgrade");
  });

  it("has config hook handlers", () => {
    expect(pluginDeploy.hookHandlers).toBeDefined();
    expect(pluginDeploy.hookHandlers!.config).toBeDefined();
  });

  it("deploy task has program, priorityFee, network options and skipConfirm flag", () => {
    const deployTask = pluginDeploy.tasks?.find((t) => t.id === "deploy");
    expect(deployTask).toBeDefined();

    const optionNames = deployTask!.options?.map((o) => o.name) ?? [];
    expect(optionNames).toContain("program");
    expect(optionNames).toContain("priorityFee");
    expect(optionNames).toContain("network");

    const flagNames = deployTask!.flags?.map((f) => f.name) ?? [];
    expect(flagNames).toContain("skipConfirm");
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
  });
});

// ---------------------------------------------------------------------------
// Constructor validation tests
// ---------------------------------------------------------------------------

describe("validateConstructor", () => {
  it("throws DeployError when constructor is null", () => {
    expect(() => validateConstructor(null, "hello.aleo")).toThrow(DeployError);
    expect(() => validateConstructor(null, "hello.aleo")).toThrow(
      "has no constructor annotation",
    );
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
    expect(() =>
      validateConstructor({ type: "noupgrade" }, "hello.aleo"),
    ).not.toThrow();
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
    expect(() =>
      validateConstructor({ type: "admin" }, "token.aleo"),
    ).toThrow("no address specified");
  });

  it("throws for @admin with invalid address", () => {
    expect(() =>
      validateConstructor(
        { type: "admin", adminAddress: "invalid_address" },
        "token.aleo",
      ),
    ).toThrow("invalid address");
  });

  it("accepts @custom constructor (warns but does not throw)", () => {
    expect(() =>
      validateConstructor({ type: "custom" }, "dao.aleo"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Upgrade permission validation tests
// ---------------------------------------------------------------------------

describe("validateUpgradePermission", () => {
  const baseManifest: DeployManifest = {
    programId: "hello.aleo",
    network: "devnode",
    endpoint: "http://127.0.0.1:3030",
    txId: "at1test",
    blockHeight: 42,
    edition: 0,
    constructorType: "noupgrade",
    constructorAdmin: null,
    deployedAt: "2026-04-08T12:00:00.000Z",
  };

  it("throws for @noupgrade programs", () => {
    expect(() =>
      validateUpgradePermission(baseManifest, "hello.aleo"),
    ).toThrow("@noupgrade");
    expect(() =>
      validateUpgradePermission(baseManifest, "hello.aleo"),
    ).toThrow("cannot be upgraded");
  });

  it("allows @admin programs", () => {
    const manifest: DeployManifest = {
      ...baseManifest,
      constructorType: "admin",
      constructorAdmin: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    };
    expect(() =>
      validateUpgradePermission(manifest, "hello.aleo"),
    ).not.toThrow();
  });

  it("allows @custom programs (with warning)", () => {
    const manifest: DeployManifest = {
      ...baseManifest,
      constructorType: "custom",
    };
    expect(() =>
      validateUpgradePermission(manifest, "hello.aleo"),
    ).not.toThrow();
  });

  it("throws for unknown constructor type", () => {
    const manifest: DeployManifest = {
      ...baseManifest,
      constructorType: "unknown" as any,
    };
    expect(() =>
      validateUpgradePermission(manifest, "hello.aleo"),
    ).toThrow("unknown constructor type");
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
