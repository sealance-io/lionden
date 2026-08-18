/**
 * `--deploy-backend` eager validation.
 *
 * These drive the *real* `parseArgs` rather than a hand-written value, because
 * the case worth protecting — a value-less flag recording nothing at all — only
 * exists as a property of the parser.
 */

import { ArgumentType, type GlobalOptionDefinition, task } from "@lionden/core";
import { describe, expect, it } from "vitest";
import { assertDeployBackendArg, sawDeployBackendFlag } from "./deploy-backend-arg.js";
import { parseArgs } from "./task-dispatch.js";

const deployBackendOption: GlobalOptionDefinition = {
  name: "deployBackend",
  type: ArgumentType.STRING,
  description: "Backend that builds deploy/upgrade transactions",
};

const globalOptionDefs = new Map([
  ["deployBackend", { pluginId: "@lionden/plugin-deploy", definition: deployBackendOption }],
]);

const deployTask = task("deploy", "Deploy")
  .setAction(async () => undefined)
  .build();

/** Parse `argv` the way `main()` does, then run the check over both. */
function check(argv: string[]): void {
  const parsed = parseArgs(argv, globalOptionDefs, (id) =>
    id === "deploy" ? deployTask : undefined,
  );
  assertDeployBackendArg(argv, (parsed.globalArgs as Record<string, unknown>)["deployBackend"]);
}

describe("sawDeployBackendFlag", () => {
  it.each([
    ["--deploy-backend", "leo"],
    ["--deployBackend", "leo"],
  ])("matches the %s spelling", (...argv) => {
    expect(sawDeployBackendFlag(argv)).toBe(true);
  });

  it.each([
    "--deploy-backend=leo",
    "--deployBackend=leo",
    "--deploy-backend=",
  ])("matches the inline form %s", (arg) => {
    expect(sawDeployBackendFlag([arg])).toBe(true);
  });

  it("does not match an unrelated flag with a shared prefix", () => {
    expect(sawDeployBackendFlag(["--deploy-backend-extra", "x"])).toBe(false);
    expect(sawDeployBackendFlag(["deploy", "--network", "devnode"])).toBe(false);
  });
});

describe("assertDeployBackendArg", () => {
  it("accepts every known provider", () => {
    expect(() => check(["deploy", "--deploy-backend", "sdk"])).not.toThrow();
    expect(() => check(["deploy", "--deploy-backend", "leo"])).not.toThrow();
    expect(() => check(["deploy", "--deploy-backend=leo"])).not.toThrow();
  });

  it("stays out of the way when the flag is absent", () => {
    expect(() => check(["deploy"])).not.toThrow();
    expect(() => check(["deploy", "--network", "devnode"])).not.toThrow();
  });

  it("rejects an unrecognized value", () => {
    expect(() => check(["deploy", "--deploy-backend", "provable"])).toThrow(
      /"provable" \(from --deploy-backend\) is not recognized/,
    );
  });

  it("rejects an inline empty value", () => {
    expect(() => check(["deploy", "--deploy-backend="])).toThrow(/requires a value/);
  });

  /**
   * The parser deliberately does not consume a task token as an option value —
   * that is what keeps `lionden --network deploy` dispatching `deploy`. The
   * consequence is that `deployBackend` is never recorded here, so a check on
   * the parsed value alone would see "unset" and fall through to the SDK.
   */
  it("rejects a value-less flag that the parser records nothing for", () => {
    const argv = ["--deploy-backend", "deploy"];
    const parsed = parseArgs(argv, globalOptionDefs, (id) =>
      id === "deploy" ? deployTask : undefined,
    );
    // Guard the premise: if this ever starts being recorded, the test below is
    // no longer testing what it claims.
    expect(parsed.taskId).toBe("deploy");
    expect((parsed.globalArgs as Record<string, unknown>)["deployBackend"]).toBeUndefined();

    expect(() => check(argv)).toThrow(/requires a value/);
  });

  it("rejects a trailing value-less flag", () => {
    expect(() => check(["deploy", "--deploy-backend"])).toThrow(/requires a value/);
  });

  it("names the available backends in both failure messages", () => {
    expect(() => check(["deploy", "--deploy-backend"])).toThrow(/sdk, leo/);
    expect(() => check(["deploy", "--deploy-backend", "nope"])).toThrow(/sdk, leo/);
  });
});
