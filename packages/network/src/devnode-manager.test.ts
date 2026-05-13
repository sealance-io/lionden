import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DevnodeManager } from "./devnode-manager.js";
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
  stderr: EventEmitter;
} {
  const proc = new EventEmitter() as any;
  proc.exitCode = null;
  proc.kill = vi.fn((signal?: string) => {
    proc.exitCode = signal === "SIGKILL" ? 137 : 0;
    proc.emit("exit", proc.exitCode);
    return true;
  });
  proc.stderr = new EventEmitter();
  return proc;
}

describe("DevnodeManager", () => {
  let manager: DevnodeManager;

  beforeEach(() => {
    manager = new DevnodeManager();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.stop();
  });

  it("isRunning returns false initially", () => {
    expect(manager.isRunning()).toBe(false);
  });

  it("start spawns leo devnode with correct args", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    // Health check succeeds immediately
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ socketAddr: "127.0.0.1:4040" });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      [
        "--disable-update-check",
        "devnode",
        "start",
        "--socket-addr",
        "127.0.0.1:4040",
        "--private-key",
        "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
      ],
      expect.objectContaining({ stdio: ["ignore", "ignore", "pipe"] }),
    );
    expect(manager.endpoint).toBe("http://127.0.0.1:4040");
  });

  it("start uses default socket address", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      [
        "--disable-update-check",
        "devnode",
        "start",
        "--private-key",
        "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
      ],
      expect.any(Object),
    );
    expect(manager.endpoint).toBe("http://127.0.0.1:3030");
  });

  it("start passes --no-auto-block when autoBlock is false", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ autoBlock: false });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--manual-block-creation"]),
      expect.any(Object),
    );
  });

  it("start passes verbosity flags", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ verbosity: 2 });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--verbosity", "2"]),
      expect.any(Object),
    );
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

    // Simulate spawn error
    setTimeout(() => {
      mockProc.emit("error", new Error("ENOENT"));
    }, 10);

    await expect(manager.start()).rejects.toThrow("Failed to start devnode");
  });

  it("start uses custom leoBinary", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ leoBinary: "/usr/local/bin/leo-3.5" });

    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/leo-3.5",
      expect.arrayContaining(["--disable-update-check", "devnode", "start"]),
      expect.any(Object),
    );
  });

  it("passes --disable-update-check before devnode start", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args.slice(0, 3)).toEqual([
      "--disable-update-check",
      "devnode",
      "start",
    ]);
  });

  it("start passes --consensus-heights when set", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ consensusHeights: "0,1,2,3,4,5,6,7,8" });

    expect(spawn).toHaveBeenCalledWith(
      "leo",
      expect.arrayContaining(["--consensus-heights", "0,1,2,3,4,5,6,7,8"]),
      expect.any(Object),
    );
  });

  it("start omits --consensus-heights when not set", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args).not.toContain("--consensus-heights");
  });

  it("throws on non-zero exit code", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockRejectedValue(new Error("connection refused"));

    // Simulate process exit with error
    setTimeout(() => {
      mockProc.exitCode = 1;
      mockProc.emit("exit", 1);
    }, 10);

    await expect(manager.start()).rejects.toThrow("exited with code 1");
  });
});
