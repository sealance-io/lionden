import { execFile } from "node:child_process";
import type { LionDenResolvedConfig } from "@lionden/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLeoPreflightMemoForTests,
  parseLeoVersionOutput,
  preflightLeo,
} from "./leo-preflight.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

function makeConfig(overrides: Partial<LionDenResolvedConfig> = {}): LionDenResolvedConfig {
  return {
    leoVersion: "4.0.0",
    skipLeoVersionCheck: false,
    leoBinary: "/tmp/leo",
    paths: {
      root: "/tmp/test",
      programs: "/tmp/test/programs",
      artifacts: "/tmp/test/artifacts",
      typechain: "/tmp/test/typechain",
      cache: "/tmp/test/cache",
      deployments: "/tmp/test/deployments",
    },
    networks: {},
    defaultNetwork: "devnode",
    compiler: {
      enableDce: true,
      conditionalBlockMaxDepth: 10,
      buildTests: false,
      extraFlags: [],
    },
    codegen: { enabled: true, outDir: "typechain", dynamicRecords: {} },
    testing: { framework: "vitest", timeout: 120_000, autoStartDevnode: true },
    execution: { imports: {} },
    deploy: {
      defaultPriorityFee: 0,
      privateFee: false,
      confirmTransactions: true,
      confirmationTimeout: 60_000,
      deploymentsDir: "deployments",
      skipDeployed: true,
      autoExport: false,
    },
    sdk: { keyCache: { storage: "memory" } },
    namedAccounts: {},
    ...overrides,
  };
}

function mockExecFileSuccess(stdout: string, stderr = ""): void {
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    (
      callback as unknown as (
        error: Error | null,
        result: { stdout: string; stderr: string },
      ) => void
    )(null, { stdout, stderr });
    return {} as ReturnType<typeof execFile>;
  });
}

function mockExecFileFailure(error: Error & { code?: string | number }): void {
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    (callback as (error: Error) => void)(error);
    return {} as ReturnType<typeof execFile>;
  });
}

describe("parseLeoVersionOutput", () => {
  it("parses Leo version output with commit metadata", () => {
    expect(parseLeoVersionOutput("leo 4.0.2 (13448848d9 HEAD) features=[noconfig]"))?.toMatchObject(
      { major: 4, minor: 0, patch: 2, text: "4.0.2" },
    );
  });

  it("takes the first stable version match", () => {
    expect(parseLeoVersionOutput("wrapper 1.2.3\nleo 4.0.2")?.text).toBe("1.2.3");
  });

  it("rejects prerelease and build metadata matches", () => {
    expect(parseLeoVersionOutput("leo 4.0.0-rc1")).toBeNull();
    expect(parseLeoVersionOutput("leo 4.0.0+build")).toBeNull();
  });
});

describe("preflightLeo", () => {
  beforeEach(() => {
    clearLeoPreflightMemoForTests();
    vi.clearAllMocks();
  });

  it("passes --disable-update-check before --version", async () => {
    mockExecFileSuccess("leo 4.0.2 (13448848d9 HEAD)");

    await preflightLeo(makeConfig());

    expect(execFile).toHaveBeenCalledWith(
      "/tmp/leo",
      ["--disable-update-check", "--version"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("accepts patch drift within the configured line", async () => {
    mockExecFileSuccess("leo 4.0.2 (13448848d9 HEAD)");

    await expect(preflightLeo(makeConfig({ leoVersion: "4.0.0" }))).resolves.toBeUndefined();
  });

  it("accepts Leo 4.1 when configured for the 4.1 line", async () => {
    mockExecFileSuccess("leo 4.1.0");

    await expect(preflightLeo(makeConfig({ leoVersion: "4.1.0" }))).resolves.toBeUndefined();
  });

  it("rejects unparseable output when checking is enabled", async () => {
    mockExecFileSuccess("leo dev build");

    await expect(preflightLeo(makeConfig())).rejects.toThrow(/could not parse/);
  });

  it("tolerates unparseable output when skipLeoVersionCheck is true", async () => {
    mockExecFileSuccess("leo dev build");

    await expect(preflightLeo(makeConfig({ skipLeoVersionCheck: true }))).resolves.toBeUndefined();
  });

  it("rejects a binary from a different minor line", async () => {
    mockExecFileSuccess("leo 4.1.0");

    await expect(preflightLeo(makeConfig({ leoVersion: "4.0.0" }))).rejects.toThrow(
      /requires 4\.0\.x/,
    );
  });

  it("allows a different minor line when skipLeoVersionCheck is true", async () => {
    mockExecFileSuccess("leo 4.1.0");

    await expect(
      preflightLeo(makeConfig({ leoVersion: "4.0.0", skipLeoVersionCheck: true })),
    ).resolves.toBeUndefined();
  });

  it("fails clearly for missing or inaccessible binaries", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    mockExecFileFailure(err);

    await expect(preflightLeo(makeConfig({ leoBinary: "/expanded/missing/leo" }))).rejects.toThrow(
      /\/expanded\/missing\/leo/,
    );
  });

  it("does not skip missing binaries when skipLeoVersionCheck is true", async () => {
    const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    mockExecFileFailure(err);

    await expect(
      preflightLeo(
        makeConfig({
          leoBinary: "/expanded/inaccessible/leo",
          skipLeoVersionCheck: true,
        }),
      ),
    ).rejects.toThrow(/\/expanded\/inaccessible\/leo/);
  });

  it("memoizes failures by binary, expected line, and skip flag", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    mockExecFileFailure(err);
    const config = makeConfig({ leoBinary: "/tmp/missing-leo" });

    await expect(preflightLeo(config)).rejects.toThrow();
    await expect(preflightLeo(config)).rejects.toThrow();

    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
