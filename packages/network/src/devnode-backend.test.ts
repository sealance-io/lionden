import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the version probe.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
// preflightDevnode delegates to core's preflightLeo for the leo branch.
vi.mock("@lionden/core", () => ({ preflightLeo: vi.fn() }));

import { execFile } from "node:child_process";
import { clearDevnodeBackendProbeCacheForTests, resolveDevnodeBackend } from "./devnode-backend.js";

// execFile is promisified via util.promisify, which uses the callback form.
function mockProbe(succeeds: boolean): void {
  // promisify(execFile) calls execFile(cmd, args, options, callback) — the
  // callback is always the last argument.
  vi.mocked(execFile).mockImplementation(((...args: any[]) => {
    const cb = args[args.length - 1];
    if (succeeds) cb(null, { stdout: "aleo-devnode 0.2.0", stderr: "" });
    else cb(new Error("ENOENT"), { stdout: "", stderr: "" });
    return {} as any;
  }) as any);
}

describe("resolveDevnodeBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDevnodeBackendProbeCacheForTests();
  });

  it("auto-detect picks standalone when aleo-devnode is present", async () => {
    mockProbe(true);
    const b = await resolveDevnodeBackend({});
    expect(b.provider).toBe("standalone");
    expect(b.capabilities.snapshot).toBe(true);
  });

  it("auto-detect falls back to leo when aleo-devnode is absent", async () => {
    mockProbe(false);
    const b = await resolveDevnodeBackend({ leoBinary: "leo" });
    expect(b.provider).toBe("leo");
    expect(b.command).toBe("leo");
    expect(b.capabilities.snapshot).toBe(false);
  });

  it("provider: leo never probes and stays leo", async () => {
    const b = await resolveDevnodeBackend({ provider: "leo" });
    expect(b.provider).toBe("leo");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("requiresPersistence throws when standalone is unavailable", async () => {
    mockProbe(false);
    await expect(resolveDevnodeBackend({ requiresPersistence: true })).rejects.toThrow(
      /could not be found/,
    );
  });

  it("requiresPersistence with provider:leo throws (cannot snapshot on leo)", async () => {
    await expect(
      resolveDevnodeBackend({ provider: "leo", requiresPersistence: true }),
    ).rejects.toThrow(/pinned to "leo"/);
  });

  it("explicit binary probes that path and throws on failure", async () => {
    mockProbe(false);
    await expect(resolveDevnodeBackend({ binary: "/opt/aleo-devnode" })).rejects.toThrow(
      /\/opt\/aleo-devnode/,
    );
  });

  it("explicit binary selects standalone when runnable", async () => {
    mockProbe(true);
    const b = await resolveDevnodeBackend({ binary: "/opt/aleo-devnode" });
    expect(b.provider).toBe("standalone");
    expect(b.command).toBe("/opt/aleo-devnode");
  });

  it("standalone rejects non-testnet network (explicit provider)", async () => {
    await expect(
      resolveDevnodeBackend({ provider: "standalone", network: "mainnet" }),
    ).rejects.toThrow(/only supports the "testnet"/);
  });

  it("standalone rejects consensusHeights (auto-detected)", async () => {
    mockProbe(true);
    await expect(resolveDevnodeBackend({ consensusHeights: "0,1,2" })).rejects.toThrow(
      /consensusHeights is not supported/,
    );
  });
});
