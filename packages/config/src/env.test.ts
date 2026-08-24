import { describe, expect, it, vi } from "vitest";
import { parseBooleanEnv } from "./env.js";

describe("parseBooleanEnv", () => {
  it.each(["true", "t", "yes", "y", "1", "on", "enabled"])(
    "treats %s as true (case/space insensitive)",
    (token) => {
      expect(parseBooleanEnv(token)).toBe(true);
      expect(parseBooleanEnv(`  ${token.toUpperCase()}  `)).toBe(true);
    },
  );

  it.each(["false", "f", "no", "n", "0", "off", "disabled"])(
    "treats %s as false (case/space insensitive)",
    (token) => {
      expect(parseBooleanEnv(token, true)).toBe(false);
      expect(parseBooleanEnv(`  ${token.toUpperCase()}  `, true)).toBe(false);
    },
  );

  it("returns the default for undefined and empty string", () => {
    expect(parseBooleanEnv(undefined)).toBe(false);
    expect(parseBooleanEnv("")).toBe(false);
    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv("", true)).toBe(true);
  });

  it("defaults to false when no default is given", () => {
    expect(parseBooleanEnv("maybe")).toBe(false);
  });

  it("returns the default for unrecognized values and calls onInvalid once with the raw value", () => {
    const onInvalid = vi.fn();
    expect(parseBooleanEnv("maybe", true, onInvalid)).toBe(true);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid).toHaveBeenCalledWith("maybe");
  });

  it("does not call onInvalid for recognized or empty values", () => {
    const onInvalid = vi.fn();
    parseBooleanEnv("yes", false, onInvalid);
    parseBooleanEnv("no", false, onInvalid);
    parseBooleanEnv("", false, onInvalid);
    parseBooleanEnv(undefined, false, onInvalid);
    expect(onInvalid).not.toHaveBeenCalled();
  });
});
