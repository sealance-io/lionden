import { afterEach, describe, expect, it } from "vitest";
import {
  logAction,
  logDivider,
  logError,
  logMetadata,
  logSuccess,
  logWarning,
  pluralize,
  shouldRenderDivider,
  styleLogRole,
} from "./log-style.js";

const originalNoColor = process.env["NO_COLOR"];
const originalForceColor = process.env["FORCE_COLOR"];
const originalVitest = process.env["VITEST"];
const originalManagedTest = process.env["LIONDEN_MANAGED_TEST"];
const originalIsTTY = process.stdout.isTTY;

function restoreColorEnvironment(): void {
  if (originalNoColor === undefined) {
    delete process.env["NO_COLOR"];
  } else {
    process.env["NO_COLOR"] = originalNoColor;
  }
  if (originalForceColor === undefined) {
    delete process.env["FORCE_COLOR"];
  } else {
    process.env["FORCE_COLOR"] = originalForceColor;
  }
  if (originalVitest === undefined) {
    delete process.env["VITEST"];
  } else {
    process.env["VITEST"] = originalVitest;
  }
  if (originalManagedTest === undefined) {
    delete process.env["LIONDEN_MANAGED_TEST"];
  } else {
    process.env["LIONDEN_MANAGED_TEST"] = originalManagedTest;
  }
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalIsTTY,
  });
}

describe("log style helpers", () => {
  afterEach(() => {
    restoreColorEnvironment();
  });

  it("returns plain text when NO_COLOR is set", () => {
    process.env["NO_COLOR"] = "1";
    process.env["FORCE_COLOR"] = "1";
    delete process.env["VITEST"];
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    expect(logAction("Running task")).toBe("Running task");
    expect(logSuccess("Deployed")).toBe("Deployed");
    expect(logWarning("Skipping")).toBe("Skipping");
    expect(logError("Rejected")).toBe("Rejected");
    expect(logMetadata("(tx: at1)")).toBe("(tx: at1)");
    expect(logDivider()).toBe("----------------------------------------");
  });

  it("returns plain text for non-TTY output", () => {
    delete process.env["NO_COLOR"];
    delete process.env["FORCE_COLOR"];
    delete process.env["VITEST"];
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    expect(logAction("Submitting")).toBe("Submitting");
    expect(logMetadata("(tx: at1)")).toBe("(tx: at1)");
  });

  it("colors semantic segments for TTY output", () => {
    delete process.env["NO_COLOR"];
    delete process.env["FORCE_COLOR"];
    delete process.env["VITEST"];
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    expect(logAction("Submitting")).toBe("\x1b[36mSubmitting\x1b[0m");
    expect(logSuccess("Submitted")).toBe("\x1b[32mSubmitted\x1b[0m");
    expect(logWarning("Skipping")).toBe("\x1b[33mSkipping\x1b[0m");
    expect(logError("Rejected")).toBe("\x1b[31mRejected\x1b[0m");
    expect(logMetadata("(tx: at1)")).toBe("\x1b[2m(tx: at1)\x1b[0m");
    expect(logDivider()).toBe("\x1b[2m----------------------------------------\x1b[0m");
  });

  it("styles semantic roles consistently", () => {
    delete process.env["NO_COLOR"];
    delete process.env["FORCE_COLOR"];
    delete process.env["VITEST"];
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    expect(styleLogRole("Submitting", "action")).toBe(logAction("Submitting"));
    expect(styleLogRole("Submitted", "success")).toBe(logSuccess("Submitted"));
    expect(styleLogRole("Rejected", "warning")).toBe(logWarning("Rejected"));
    expect(styleLogRole("Failed", "error")).toBe(logError("Failed"));
    expect(styleLogRole("(tx: at1)", "metadata")).toBe(logMetadata("(tx: at1)"));
    expect(styleLogRole("----------------------------------------", "divider")).toBe(logDivider());
  });

  it("honors FORCE_COLOR when stdout is not a TTY", () => {
    delete process.env["NO_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    delete process.env["VITEST"];
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });

    expect(logAction("Running script")).toBe("\x1b[36mRunning script\x1b[0m");
  });

  it("suppresses dividers when running under Vitest", () => {
    process.env["VITEST"] = "true";

    expect(shouldRenderDivider()).toBe(false);
  });

  it("suppresses dividers during managed test task execution", () => {
    process.env["LIONDEN_MANAGED_TEST"] = "true";

    expect(shouldRenderDivider()).toBe(false);
  });

  it("allows dividers outside test runs", () => {
    delete process.env["VITEST"];
    delete process.env["LIONDEN_MANAGED_TEST"];

    expect(shouldRenderDivider()).toBe(true);
  });

  it("pluralizes regular log words", () => {
    expect(pluralize("program", 1)).toBe("program");
    expect(pluralize("program", 2)).toBe("programs");
  });
});
