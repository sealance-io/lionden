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
      ["devnode", "start", "--socket-addr", "127.0.0.1:4040"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
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
      ["devnode", "start"],
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
      expect.arrayContaining(["--no-auto-block"]),
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
      expect.arrayContaining(["-vv"]),
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
