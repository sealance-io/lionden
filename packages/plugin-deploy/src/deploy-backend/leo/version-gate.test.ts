import { afterEach, describe, expect, it, vi } from "vitest";
import { LeoDeployError } from "./errors.js";
import {
  assertLeoBinaryVersion,
  clearLeoVersionGateMemoForTests,
  type LeoVersionProbe,
} from "./version-gate.js";

const V43 = "leo 4.3.2 (60bbdef HEAD) features=[noconfig]";
const V44 = "leo 4.4.2 (f3578da HEAD) features=[noconfig]";
const V41 = "leo 4.1.0 (abc1234 HEAD)";

function probeReturning(output: string): LeoVersionProbe {
  return vi.fn(async () => output);
}

afterEach(() => {
  clearLeoVersionGateMemoForTests();
});

describe("assertLeoBinaryVersion", () => {
  it.each([
    ["4.3.0", "leo 4.3.0"],
    ["4.3.2", V43],
    ["4.3.11", "leo 4.3.11"],
    ["4.4.0", "leo 4.4.0"],
    ["4.4.1", "leo 4.4.1"],
    ["4.4.2", V44],
  ])("accepts a %s binary", async (_label, output) => {
    await expect(
      assertLeoBinaryVersion("/bin/leo", probeReturning(output)),
    ).resolves.toBeUndefined();
  });

  it("rejects an unsupported line and names what it found", async () => {
    const error = await assertLeoBinaryVersion("/bin/leo", probeReturning(V41)).catch((e) => e);
    expect(error).toBeInstanceOf(LeoDeployError);
    expect(error.stage).toBe("version-gate");
    expect(error.message).toContain("4.1.0");
    expect(error.message).toContain("--deploy-backend sdk");
  });

  /**
   * The two gaps this check exists to close. `preflightLeo` returns before
   * comparing versions when `skipLeoVersionCheck` is set, and it is not invoked
   * at all under `--noCompile` — so neither can be relied on here.
   *
   * The gate takes only a binary path precisely so that neither config flag nor
   * whether compilation ran is even representable as an input.
   */
  it("cannot be relaxed by skipLeoVersionCheck, and says so", async () => {
    // The gate takes a binary path and a probe — no config — so
    // `skipLeoVersionCheck` is not even representable as an input here. The
    // message exists because a user who set that flag will otherwise expect it
    // to apply.
    await expect(assertLeoBinaryVersion("/bin/leo", probeReturning(V41))).rejects.toThrow(
      /skipLeoVersionCheck.*does not relax this check/s,
    );
  });

  it("rejects a 4.1 binary regardless of how the run reached it", async () => {
    // Both the --noCompile path and the skipLeoVersionCheck path arrive here
    // identically: one probe, one verdict.
    for (const label of ["noCompile", "skipLeoVersionCheck"]) {
      clearLeoVersionGateMemoForTests();
      await expect(assertLeoBinaryVersion("/bin/leo", probeReturning(V41)), label).rejects.toThrow(
        /supports Leo 4\.3\.x or 4\.4\.x only/,
      );
    }
  });

  it("accepts a supported binary on those same paths", async () => {
    await expect(assertLeoBinaryVersion("/bin/leo", probeReturning(V43))).resolves.toBeUndefined();
    clearLeoVersionGateMemoForTests();
    await expect(assertLeoBinaryVersion("/bin/leo", probeReturning(V44))).resolves.toBeUndefined();
  });

  it.each([
    ["older supported compile line", "leo 4.2.0"],
    ["future minor", "leo 4.5.0"],
    ["future major", "leo 5.0.0"],
    ["prerelease", "leo 4.4.2-rc1"],
  ])("rejects %s", async (_label, output) => {
    await expect(assertLeoBinaryVersion("/bin/leo", probeReturning(output))).rejects.toThrow();
  });

  it("reports an unparseable version rather than assuming it is fine", async () => {
    await expect(
      assertLeoBinaryVersion("/bin/leo", probeReturning("not a version")),
    ).rejects.toThrow(/Could not parse a version/);
  });

  it("reports a binary that cannot be executed", async () => {
    const probe: LeoVersionProbe = async () => {
      throw new Error("spawn ENOENT");
    };
    await expect(assertLeoBinaryVersion("/nope/leo", probe)).rejects.toThrow(
      /Could not run .*--version.*spawn ENOENT/s,
    );
  });

  describe("memoization", () => {
    it("probes once per binary across repeated calls", async () => {
      const probe = probeReturning(V43);
      await assertLeoBinaryVersion("/bin/leo", probe);
      await assertLeoBinaryVersion("/bin/leo", probe);
      await assertLeoBinaryVersion("/bin/leo", probe);
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it("probes each distinct binary", async () => {
      const a = probeReturning(V43);
      const b = probeReturning(V43);
      await assertLeoBinaryVersion("/bin/leo", a);
      await assertLeoBinaryVersion("/other/leo", b);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    /**
     * A failure must not be cached as a permanent verdict: the user can fix
     * their PATH and retry inside the same process, which the Vitest-managed
     * test task does routinely.
     */
    it("does not cache a rejection", async () => {
      await expect(assertLeoBinaryVersion("/bin/leo", probeReturning(V41))).rejects.toThrow();
      await expect(
        assertLeoBinaryVersion("/bin/leo", probeReturning(V43)),
      ).resolves.toBeUndefined();
    });

    it("is cleared by the test hook", async () => {
      const probe = probeReturning(V43);
      await assertLeoBinaryVersion("/bin/leo", probe);
      clearLeoVersionGateMemoForTests();
      await assertLeoBinaryVersion("/bin/leo", probe);
      expect(probe).toHaveBeenCalledTimes(2);
    });
  });
});
