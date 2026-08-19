import { describe, expect, it } from "vitest";
import { DeployError } from "../../errors.js";
import { assertNoSkipCollision, buildLeoArgv, type LeoArgvOptions } from "./argv.js";

const BASE: LeoArgvOptions = {
  operation: "deploy",
  programId: "hello.aleo",
  packageDir: "/proj/artifacts/.build/hello.aleo",
  saveDir: "/tmp/lionden-leotx-abc",
  jsonOutputPath: "/tmp/lionden-leotx-abc/result.json",
  networkId: "testnet",
  endpoint: "http://127.0.0.1:3030",
  connectionType: "devnode",
  priorityFee: 0,
  privateFee: false,
  localDependencyIds: [],
  prove: false,
};

const opts = (over: Partial<LeoArgvOptions> = {}): LeoArgvOptions => ({ ...BASE, ...over });

describe("buildLeoArgv", () => {
  it("builds the devnode no-prove baseline", () => {
    expect(buildLeoArgv(opts())).toEqual([
      "--disable-update-check",
      "deploy",
      "--path",
      "/proj/artifacts/.build/hello.aleo",
      "--save",
      "/tmp/lionden-leotx-abc",
      "--json-output=/tmp/lionden-leotx-abc/result.json",
      "--yes",
      "--network",
      "testnet",
      "--endpoint",
      "http://127.0.0.1:3030",
      "--devnet",
      "--skip-deploy-certificate",
    ]);
  });

  /**
   * A daily update probe interposing on a deploy would be, at best, a confusing
   * delay. `runLeoBuild` already leads with this flag.
   */
  it("puts --disable-update-check first", () => {
    expect(buildLeoArgv(opts())[0]).toBe("--disable-update-check");
  });

  it("names the operation second, so upgrade shares the flag surface", () => {
    expect(buildLeoArgv(opts({ operation: "upgrade" }))[1]).toBe("upgrade");
  });

  describe("--skip-deploy-certificate", () => {
    // Placeholder certificates and verifying keys are rejected by a real
    // network, which is why this mirrors the SDK's devnode-only fast path.
    it("is emitted on devnode without prove", () => {
      expect(buildLeoArgv(opts())).toContain("--skip-deploy-certificate");
    });

    it("is omitted on devnode with prove", () => {
      expect(buildLeoArgv(opts({ prove: true }))).not.toContain("--skip-deploy-certificate");
    });

    it("is omitted on http regardless of prove", () => {
      for (const prove of [true, false]) {
        expect(
          buildLeoArgv(opts({ connectionType: "http", prove })),
          `prove=${prove}`,
        ).not.toContain("--skip-deploy-certificate");
      }
    });
  });

  describe("--devnet", () => {
    it("is emitted on devnode", () => {
      expect(buildLeoArgv(opts())).toContain("--devnet");
    });

    it("is omitted on http", () => {
      expect(buildLeoArgv(opts({ connectionType: "http" }))).not.toContain("--devnet");
    });
  });

  describe("--consensus-heights", () => {
    it("is emitted on devnode when configured", () => {
      const argv = buildLeoArgv(opts({ consensusHeights: "0,10,20" }));
      expect(argv).toContain("--consensus-heights");
      expect(argv[argv.indexOf("--consensus-heights") + 1]).toBe("0,10,20");
    });

    it("is omitted when unset", () => {
      expect(buildLeoArgv(opts())).not.toContain("--consensus-heights");
    });

    // A custom consensus schedule is meaningless against a real network.
    it("is omitted on http even when configured", () => {
      expect(
        buildLeoArgv(opts({ connectionType: "http", consensusHeights: "0,10,20" })),
      ).not.toContain("--consensus-heights");
    });
  });

  describe("fees", () => {
    it("emits a bare integer priority fee", () => {
      const argv = buildLeoArgv(opts({ priorityFee: 1500 }));
      expect(argv[argv.indexOf("--priority-fees") + 1]).toBe("1500");
    });

    it("omits the priority fee when zero", () => {
      expect(buildLeoArgv(opts())).not.toContain("--priority-fees");
    });

    it("emits -f default for a private fee", () => {
      const argv = buildLeoArgv(opts({ privateFee: true }));
      expect(argv[argv.indexOf("-f") + 1]).toBe("default");
    });

    it("omits -f for a public fee", () => {
      expect(buildLeoArgv(opts())).not.toContain("-f");
    });
  });

  describe("--skip", () => {
    it("emits one flag per dependency, repeated rather than variadic", () => {
      const argv = buildLeoArgv(opts({ localDependencyIds: ["a_dep.aleo", "b_dep.aleo"] }));
      const skips = argv.reduce<string[]>(
        (acc, tok, i) => (tok === "--skip" ? [...acc, argv[i + 1]!] : acc),
        [],
      );
      expect(skips).toEqual(["a_dep.aleo", "b_dep.aleo"]);
    });

    it("emits none when there are no local dependencies", () => {
      expect(buildLeoArgv(opts())).not.toContain("--skip");
    });
  });

  describe("verbosity", () => {
    it.each([
      ["silent", "-q"],
      ["error", "-q"],
      ["debug", "-d"],
    ] as const)("maps sdk.logLevel %s to %s", (logLevel, flag) => {
      expect(buildLeoArgv(opts({ logLevel }))).toContain(flag);
    });

    it.each(["warn", "info"] as const)("emits no verbosity flag for %s", (logLevel) => {
      const argv = buildLeoArgv(opts({ logLevel }));
      expect(argv).not.toContain("-q");
      expect(argv).not.toContain("-d");
    });

    it("emits no verbosity flag when unset", () => {
      const argv = buildLeoArgv(opts());
      expect(argv).not.toContain("-q");
      expect(argv).not.toContain("-d");
    });
  });

  describe("flags that must never appear", () => {
    /**
     * Each of these is a decision, not an omission:
     * - `--no-cache` defeats the `~/.aleo` key cache, which is the resumability
     *   this backend exists to provide.
     * - `--rename` would rename a second time; the materializer already did it.
     * - `--broadcast` would take broadcasting away from lionden and re-expose
     *   Leo's exit-0-on-rejection behaviour.
     * - `--private-key` would put the key on the process list.
     */
    it.each([
      "--no-cache",
      "--rename",
      "--broadcast",
      "--private-key",
      "--build-tests",
      "--no-local",
      "--offline",
      "-p",
      "--package",
    ])("never emits %s", (flag) => {
      const argv = buildLeoArgv(
        opts({
          connectionType: "http",
          prove: true,
          priorityFee: 42,
          privateFee: true,
          consensusHeights: "0,1",
          logLevel: "debug",
          localDependencyIds: ["dep.aleo"],
        }),
      );
      expect(argv).not.toContain(flag);
    });

    it("never carries anything resembling a private key", () => {
      const argv = buildLeoArgv(opts({ localDependencyIds: ["dep.aleo"] }));
      expect(argv.join(" ")).not.toMatch(/APrivateKey1/);
    });
  });
});

describe("assertNoSkipCollision", () => {
  /**
   * Leo matches `--skip` by substring, confirmed empirically: `--skip
   * spike_a.aleo` also dropped `zspike_a.aleo`. Without this check Leo exits 0
   * having built nothing, surfacing only as a confusing no-file error later.
   */
  it("rejects a dependency whose id is a substring of the target", () => {
    expect(() => assertNoSkipCollision("deploy", "zspike_a.aleo", ["spike_a.aleo"])).toThrow(
      DeployError,
    );
    expect(() => assertNoSkipCollision("deploy", "zspike_a.aleo", ["spike_a.aleo"])).toThrow(
      /would also suppress the program itself/,
    );
  });

  it("names both ids and offers the SDK backend", () => {
    try {
      assertNoSkipCollision("deploy", "zspike_a.aleo", ["spike_a.aleo"]);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("zspike_a.aleo");
      expect(message).toContain("spike_a.aleo");
      expect(message).toContain("--deploy-backend sdk");
    }
  });

  it("accepts unrelated dependency ids", () => {
    expect(() =>
      assertNoSkipCollision("deploy", "main.aleo", ["a_dep.aleo", "b_dep.aleo"]),
    ).not.toThrow();
  });

  it("is enforced by buildLeoArgv, not merely available beside it", () => {
    expect(() =>
      buildLeoArgv(opts({ programId: "zspike_a.aleo", localDependencyIds: ["spike_a.aleo"] })),
    ).toThrow(/would also suppress/);
  });

  /**
   * The rename case the closure contract exists for. `renamed_hello.aleo`
   * contains `hello.aleo`, so subtracting the *effective* id from the closure
   * would leave `--skip hello.aleo` in place and Leo would skip the very
   * program being deployed. Correct subtraction removes the source root, so
   * only the genuine dependency remains and no collision exists.
   */
  it("passes for a rename whose effective id contains its source id", () => {
    expect(() =>
      assertNoSkipCollision("deploy", "renamed_hello.aleo", ["util.aleo"]),
    ).not.toThrow();
  });

  it("catches the rename case when the root was subtracted incorrectly", () => {
    // What a wrong subtraction would produce: the source id still in the skips.
    expect(() =>
      assertNoSkipCollision("deploy", "renamed_hello.aleo", ["util.aleo", "hello.aleo"]),
    ).toThrow(/would also suppress/);
  });

  /** The message names the command the user actually ran. */
  it("says upgrade when upgrading", () => {
    expect(() => assertNoSkipCollision("upgrade", "zspike_a.aleo", ["spike_a.aleo"])).toThrow(
      /Cannot upgrade "zspike_a\.aleo"/,
    );
    expect(() => assertNoSkipCollision("deploy", "zspike_a.aleo", ["spike_a.aleo"])).toThrow(
      /Cannot deploy "zspike_a\.aleo"/,
    );
  });
});
