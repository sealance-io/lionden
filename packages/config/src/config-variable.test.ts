import { afterEach, describe, expect, it } from "vitest";
import { configVariable, isConfigVariable, resolveConfigVariable } from "./config-variable.js";

describe("configVariable", () => {
  it("creates a ConfigVariable object", () => {
    const v = configVariable("MY_VAR");
    expect(v._type).toBe("ConfigVariable");
    expect(v.name).toBe("MY_VAR");
    expect(v.defaultValue).toBeUndefined();
  });

  it("creates a ConfigVariable with default", () => {
    const v = configVariable("MY_VAR", "fallback");
    expect(v.defaultValue).toBe("fallback");
  });
});

describe("isConfigVariable", () => {
  it("returns true for ConfigVariable", () => {
    expect(isConfigVariable(configVariable("X"))).toBe(true);
  });

  it("returns false for non-ConfigVariable", () => {
    expect(isConfigVariable("string")).toBe(false);
    expect(isConfigVariable(null)).toBe(false);
    expect(isConfigVariable({})).toBe(false);
    expect(isConfigVariable({ _type: "other" })).toBe(false);
  });
});

describe("resolveConfigVariable", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("resolves from environment variable", () => {
    process.env["TEST_VAR"] = "from_env";
    const v = configVariable("TEST_VAR");
    expect(resolveConfigVariable(v)).toBe("from_env");
  });

  it("falls back to default when env var not set", () => {
    delete process.env["MISSING_VAR"];
    const v = configVariable("MISSING_VAR", "default_val");
    expect(resolveConfigVariable(v)).toBe("default_val");
  });

  it("throws when env var not set and no default", () => {
    delete process.env["MISSING_VAR"];
    const v = configVariable("MISSING_VAR");
    expect(() => resolveConfigVariable(v)).toThrow(
      'Configuration variable "MISSING_VAR" is not set',
    );
  });

  it("prefers env var over default", () => {
    process.env["TEST_VAR"] = "from_env";
    const v = configVariable("TEST_VAR", "default_val");
    expect(resolveConfigVariable(v)).toBe("from_env");
  });
});
