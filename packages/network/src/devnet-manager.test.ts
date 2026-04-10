import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DevnetManager } from "./devnet-manager.js";
import { EventEmitter } from "node:events";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { spawn } from "node:child_process";

function createMockProcess(): EventEmitter & {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const proc = new EventEmitter() as any;
  proc.exitCode = null;
  proc.kill = vi.fn((signal?: string) => {
    proc.exitCode = signal === "SIGKILL" ? 137 : 0;
    proc.emit("exit", proc.exitCode);
    return true;
  });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("DevnetManager", () => {
  let manager: DevnetManager;

  beforeEach(() => {
    manager = new DevnetManager();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.stop();
  });

  it("isRunning returns false initially", () => {
    expect(manager.isRunning()).toBe(false);
  });

  it("start spawns leo devnet without 'start' subcommand", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();

    const call = vi.mocked(spawn).mock.calls[0]!;
    expect(call[0]).toBe("leo");
    // Must not contain "start" — `leo devnet` has no subcommands
    expect(call[1]).not.toContain("start");
    expect(call[1]![0]).toBe("devnet");
    expect(call[1]![1]).toBe("--yes");
  });

  it("start passes --yes for non-interactive mode", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--yes"]),
      expect.any(Object),
    );
  });

  it("start passes --num-validators and --num-clients", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ numValidators: 2, numClients: 1 });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--num-validators", "2", "--num-clients", "1"]),
      expect.any(Object),
    );
  });

  it("start passes --verbosity as a numeric flag", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ verbosity: 3 });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--verbosity", "3"]),
      expect.any(Object),
    );
    // Must not use -vvv repeat pattern
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args.every((a) => !a.match(/^-v+$/))).toBe(true);
  });

  it("start passes --storage (not --storage-dir)", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ storageDir: "/tmp/devnet-data" });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--storage", "/tmp/devnet-data"]),
      expect.any(Object),
    );
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args).not.toContain("--storage-dir");
  });

  it("start passes --snarkos when snarkosPath is set", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ snarkosPath: "/usr/local/bin/snarkos" });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--snarkos", "/usr/local/bin/snarkos"]),
      expect.any(Object),
    );
  });

  it("start passes --network for non-testnet networks", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ network: "canary" });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--network", "canary"]),
      expect.any(Object),
    );
  });

  it("start passes --rest-port for non-default ports", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ restPort: 4040 });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--rest-port", "4040"]),
      expect.any(Object),
    );
    expect(manager.endpoint).toBe("http://127.0.0.1:4040");
  });

  it("start uses default options when none specified", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      ["devnet", "--yes"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(manager.endpoint).toBe("http://127.0.0.1:3030");
  });

  it("stop kills the process", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();
    expect(manager.isRunning()).toBe(true);

    await manager.stop();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stop is safe to call when not running", async () => {
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("throws if start is called while already running", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();

    await expect(manager.start()).rejects.toThrow("already running");
  });

  it("throws and cleans up on spawn error", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockRejectedValue(new Error("connection refused"));

    setTimeout(() => {
      mockProc.emit("error", new Error("ENOENT"));
    }, 10);

    await expect(manager.start()).rejects.toThrow("Failed to start devnet");
  });

  it("throws on non-zero exit code", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockRejectedValue(new Error("connection refused"));

    setTimeout(() => {
      mockProc.exitCode = 1;
      mockProc.emit("exit", 1);
    }, 10);

    await expect(manager.start()).rejects.toThrow("exited with code 1");
  });
});
