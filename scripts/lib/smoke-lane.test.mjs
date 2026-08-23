/**
 * Tier 1 — the smoke runner's deploy-backend lane.
 *
 * Both halves fail silently if they are wrong. A dropped `--deploy-backend`
 * value runs the default backend while the run header claims otherwise, and a
 * version gate that lets an unsupported line through produces a lane that looks
 * green but exercised a flag surface nobody verified.
 */

import { describe, expect, it } from "vitest";
import {
  assertLeoDeployBackendSupported,
  LEO_DEPLOY_BACKEND_LINE,
  parseArgs,
} from "./smoke-lane.mjs";

describe("parseArgs", () => {
  it("defaults to no explicit backend, typecheck on, no groups", () => {
    expect(parseArgs([])).toEqual({
      listOnly: false,
      typecheck: true,
      prove: false,
      coverage: false,
      deployBackend: undefined,
      groups: [],
    });
  });

  it("collects groups and the existing boolean flags", () => {
    const parsed = parseArgs(["--list", "--no-typecheck", "--prove", "--coverage", "core", "all"]);
    expect(parsed).toMatchObject({
      listOnly: true,
      typecheck: false,
      prove: true,
      coverage: true,
      groups: ["core", "all"],
    });
  });

  describe("--deploy-backend", () => {
    it.each(["sdk", "leo"])("accepts %s in the separate-value form", (backend) => {
      expect(parseArgs(["--deploy-backend", backend, "core"]).deployBackend).toBe(backend);
    });

    it.each(["sdk", "leo"])("accepts %s in the inline form", (backend) => {
      expect(parseArgs([`--deploy-backend=${backend}`]).deployBackend).toBe(backend);
    });

    it("does not consume the following group as a value's neighbour", () => {
      expect(parseArgs(["--deploy-backend", "leo", "aleo-ports"]).groups).toEqual(["aleo-ports"]);
    });

    /**
     * The regression this file exists for. `args[++i]` on a trailing flag
     * yields `undefined`, which then skipped validation and left the lane
     * running the configured default while reporting the requested backend.
     */
    it("rejects a trailing --deploy-backend with no value", () => {
      expect(() => parseArgs(["--deploy-backend"])).toThrow(/requires a value/);
      expect(() => parseArgs(["core", "--deploy-backend"])).toThrow(/requires a value/);
    });

    /** Swallowing the next flag as a backend name is the same bug, quieter. */
    it("rejects a --deploy-backend followed by another flag", () => {
      expect(() => parseArgs(["--deploy-backend", "--prove"])).toThrow(/requires a value/);
      expect(parseArgs.bind(null, ["--deploy-backend", "--prove", "core"])).toThrow(
        /requires a value/,
      );
    });

    it("rejects an empty inline value", () => {
      expect(() => parseArgs(["--deploy-backend="])).toThrow(/requires a value/);
    });

    it("rejects an unknown backend, naming the supported ones", () => {
      expect(() => parseArgs(["--deploy-backend", "nope"])).toThrow(
        /Unknown deploy backend "nope"\. Expected one of: sdk, leo\./,
      );
    });

    /** A typo must not fall through to the default. */
    it("rejects a wrong-case backend", () => {
      expect(() => parseArgs(["--deploy-backend", "Leo"])).toThrow(/Unknown deploy backend/);
    });
  });

  it("rejects an unknown option instead of treating it as a group", () => {
    expect(() => parseArgs(["--no-such-flag"])).toThrow(/Unknown option "--no-such-flag"/);
  });
});

describe("assertLeoDeployBackendSupported", () => {
  const probe = (result) => () => result;
  const ok = (stdout) => ({ error: undefined, status: 0, stdout, stderr: "" });

  it("accepts the supported line", () => {
    expect(() =>
      assertLeoDeployBackendSupported(probe(ok("leo 4.3.2 (60bbdef HEAD) features=[noconfig]"))),
    ).not.toThrow();
  });

  it("accepts any patch on the supported line", () => {
    expect(() => assertLeoDeployBackendSupported(probe(ok("leo 4.3.0")))).not.toThrow();
  });

  it("reads the version from stderr when stdout is empty", () => {
    expect(() =>
      assertLeoDeployBackendSupported(probe({ status: 0, stdout: "", stderr: "leo 4.3.2" })),
    ).not.toThrow();
  });

  it.each([
    ["an older minor", "leo 4.2.0"],
    ["an older major", "leo 3.5.0"],
    ["a newer minor", "leo 4.4.0"],
    ["a newer major", "leo 5.0.0"],
  ])("rejects %s", (_label, output) => {
    expect(() => assertLeoDeployBackendSupported(probe(ok(output)))).toThrow(
      new RegExp(`supports Leo ${LEO_DEPLOY_BACKEND_LINE}\\.x only`),
    );
  });

  it("names the version it found when rejecting a mismatched line", () => {
    expect(() => assertLeoDeployBackendSupported(probe(ok("leo 4.2.0")))).toThrow(
      /reports 4\.2\.0/,
    );
  });

  it("rejects output with no parseable version", () => {
    expect(() => assertLeoDeployBackendSupported(probe(ok("leo (dev build)")))).toThrow(
      /no stable version could be parsed/,
    );
  });

  /**
   * The backend's own gate (`parseLeoVersionOutput`) rejects non-stable
   * versions; `\b` would let them through here and fail the lane only after
   * compiling every example.
   */
  it.each([
    ["a pre-release", "leo 4.3.2-rc1"],
    ["a build suffix", "leo 4.3.2+build"],
  ])("rejects %s on the supported line", (_label, output) => {
    expect(() => assertLeoDeployBackendSupported(probe(ok(output)))).toThrow(
      /no stable version could be parsed/,
    );
  });

  it("rejects a missing binary, naming the required line", () => {
    expect(() =>
      assertLeoDeployBackendSupported(
        probe({ error: new Error("spawnSync leo ENOENT"), status: null }),
      ),
    ).toThrow(/requires a Leo 4\.3\.x binary on PATH.*spawnSync leo ENOENT/s);
  });

  it("rejects a non-zero exit even without an error object", () => {
    expect(() =>
      assertLeoDeployBackendSupported(probe({ status: 127, stdout: "", stderr: "" })),
    ).toThrow(/could not be run: exit 127/);
  });
});
