import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevnodeManager } from "./devnode-manager.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { spawn } from "node:child_process";

type MockProc = EventEmitter & {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function createMockProcess(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.exitCode = null;
  proc.kill = vi.fn((signal?: string) => {
    proc.exitCode = signal === "SIGKILL" ? 137 : 0;
    proc.emit("exit", proc.exitCode, null);
    proc.emit("close", proc.exitCode, null);
    return true;
  });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("DevnodeManager", () => {
  let manager: DevnodeManager;
  let originalEnv: string | undefined;

  beforeEach(() => {
    manager = new DevnodeManager();
    vi.clearAllMocks();
    originalEnv = process.env["LIONDEN_DEVNODE_LOGS"];
    delete process.env["LIONDEN_DEVNODE_LOGS"];
  });

  afterEach(async () => {
    await manager.stop();
    if (originalEnv === undefined) {
      delete process.env["LIONDEN_DEVNODE_LOGS"];
    } else {
      process.env["LIONDEN_DEVNODE_LOGS"] = originalEnv;
    }
  });

  it("isRunning returns false initially", () => {
    expect(manager.isRunning()).toBe(false);
  });

  it("start spawns leo devnode with correct args", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
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
    expect(args.slice(0, 3)).toEqual(["--disable-update-check", "devnode", "start"]);
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

    setTimeout(() => {
      mockProc.exitCode = 1;
      mockProc.emit("exit", 1, null);
      mockProc.emit("close", 1, null);
    }, 10);

    await expect(manager.start()).rejects.toThrow("Devnode exited (code 1)");
  });

  // ---------------------------------------------------------------------------
  // Log-mode dispatch
  // ---------------------------------------------------------------------------

  describe("logMode", () => {
    it("inherit mode passes through stdio to parent", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      await manager.start({ logMode: "inherit" });

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: ["ignore", "inherit", "inherit"] }),
      );
      expect(manager.getLogTail()).toEqual({ stdout: "", stderr: "" });
    });

    it("forward mode pipes streams, invokes callbacks, and populates buffer", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      const onStdout = vi.fn();
      const onStderr = vi.fn();

      await manager.start({ logMode: "forward", onStdout, onStderr });

      const stdoutChunk = Buffer.from("out-1\n");
      const stderrChunk = Buffer.from("err-1\n");
      mockProc.stdout.emit("data", stdoutChunk);
      mockProc.stderr.emit("data", stderrChunk);

      expect(onStdout).toHaveBeenCalledWith(stdoutChunk);
      expect(onStderr).toHaveBeenCalledWith(stderrChunk);
      expect(manager.getLogTail()).toEqual({
        stdout: "out-1\n",
        stderr: "err-1\n",
      });
    });

    it("quiet-buffered mode does not invoke forward callbacks", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      const onStdout = vi.fn();
      await manager.start({ logMode: "quiet-buffered", onStdout });
      mockProc.stdout.emit("data", Buffer.from("hi"));

      expect(onStdout).not.toHaveBeenCalled();
      expect(manager.getLogTail().stdout).toBe("hi");
    });
  });

  // ---------------------------------------------------------------------------
  // Structural invariant: drain listeners attach synchronously before yielding.
  // ---------------------------------------------------------------------------

  describe("structural invariant: drain listeners attach pre-yield", () => {
    it("quiet-buffered mode attaches data listeners to stdout and stderr before any await", () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      // fetch never resolves — start() yields and waits forever.
      mockFetch.mockImplementation(() => new Promise(() => {}));

      // Fire-and-forget; do NOT await. Per the invariant, the drain listeners
      // must be attached before start() yields its first await.
      void manager.start();

      expect(mockProc.stdout.listenerCount("data")).toBeGreaterThan(0);
      expect(mockProc.stderr.listenerCount("data")).toBeGreaterThan(0);
    });

    it("forward mode attaches data listeners to stdout and stderr before any await", () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockImplementation(() => new Promise(() => {}));

      void manager.start({ logMode: "forward", onStdout: () => {}, onStderr: () => {} });

      expect(mockProc.stdout.listenerCount("data")).toBeGreaterThan(0);
      expect(mockProc.stderr.listenerCount("data")).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Ring buffer trimming
  // ---------------------------------------------------------------------------

  describe("ring buffer", () => {
    it("retains only the last 64 KiB per stream", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      await manager.start();

      // Write 80 KiB of distinguishable chunks to stderr.
      const chunkSize = 1024;
      const totalChunks = 80;
      for (let i = 0; i < totalChunks; i++) {
        // Each chunk is filled with the byte value (i % 256) so we can tell
        // which chunks survived.
        mockProc.stderr.emit("data", Buffer.alloc(chunkSize, i % 256));
      }

      const { stderr } = manager.getLogTail();
      // Tail must be exactly 64 KiB; oldest 16 KiB were trimmed.
      expect(stderr.length).toBe(64 * 1024);
    });

    it("getLogTail starts empty before any chunk", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      await manager.start();

      expect(manager.getLogTail()).toEqual({ stdout: "", stderr: "" });
    });
  });

  // ---------------------------------------------------------------------------
  // Env var precedence
  // ---------------------------------------------------------------------------

  describe("LIONDEN_DEVNODE_LOGS env var", () => {
    it("=inherit applies only when caller does not pass logMode", async () => {
      process.env["LIONDEN_DEVNODE_LOGS"] = "inherit";
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      await manager.start();

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: ["ignore", "inherit", "inherit"] }),
      );
    });

    it("=1 is equivalent to =inherit", async () => {
      process.env["LIONDEN_DEVNODE_LOGS"] = "1";
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      await manager.start();

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: ["ignore", "inherit", "inherit"] }),
      );
    });

    it("=forward writes prefixed chunks to process.stderr", async () => {
      process.env["LIONDEN_DEVNODE_LOGS"] = "forward";
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await manager.start();
      mockProc.stdout.emit("data", Buffer.from("hello-stdout"));
      mockProc.stderr.emit("data", Buffer.from("hello-stderr"));

      expect(writeSpy).toHaveBeenCalledWith("[devnode] hello-stdout");
      expect(writeSpy).toHaveBeenCalledWith("[devnode] hello-stderr");

      writeSpy.mockRestore();
    });

    it("explicit caller logMode beats env var (caller > env)", async () => {
      process.env["LIONDEN_DEVNODE_LOGS"] = "inherit";
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      await manager.start({ logMode: "quiet-buffered" });

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
    });

    it("=0 has no effect", async () => {
      process.env["LIONDEN_DEVNODE_LOGS"] = "0";
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      await manager.start();

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // waitForExit contract
  // ---------------------------------------------------------------------------

  describe("waitForExit", () => {
    it("throws synchronously before start()", () => {
      expect(() => manager.waitForExit()).toThrow("DevnodeManager has not been started");
    });

    it("resolves after stop() with exit info", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      await manager.start();
      const exitP = manager.waitForExit();
      await manager.stop();

      await expect(exitP).resolves.toEqual({ code: 0, signal: null });
      // Second call after termination returns same info.
      await expect(manager.waitForExit()).resolves.toEqual({
        code: 0,
        signal: null,
      });
    });

    it("after spawn-time error (no exit event) resolves with { code: null, signal: null }", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockRejectedValue(new Error("connection refused"));

      setTimeout(() => {
        mockProc.emit("error", new Error("ENOENT"));
      }, 10);

      await expect(manager.start()).rejects.toThrow("Failed to start devnode");
      await expect(manager.waitForExit()).resolves.toEqual({
        code: null,
        signal: null,
      });
      expect(manager.isRunning()).toBe(false);
      // stop() must return without hanging on an exit event that will never come.
      await expect(manager.stop()).resolves.toBeUndefined();
    });

    it("signal-only exit resolves with { code: null, signal: 'SIGKILL' }", async () => {
      const mockProc = createMockProcess();
      // Override kill so it emits with signal-only exit info.
      mockProc.kill = vi.fn(() => {
        mockProc.exitCode = null;
        mockProc.emit("exit", null, "SIGKILL");
        mockProc.emit("close", null, "SIGKILL");
        return true;
      });
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await manager.start();
      // Emit exit AFTER start resolved, unexpectedly (not via stop()).
      mockProc.emit("exit", null, "SIGKILL");
      mockProc.emit("close", null, "SIGKILL");

      await expect(manager.waitForExit()).resolves.toEqual({
        code: null,
        signal: "SIGKILL",
      });
      expect(manager.isRunning()).toBe(false);
      // Diagnostic uses "signal SIGKILL", not "code null".
      const diagnosticCalls = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith("[lionden]"));
      expect(diagnosticCalls.length).toBe(1);
      expect(diagnosticCalls[0]).toContain("signal SIGKILL");
      expect(diagnosticCalls[0]).not.toContain("code null");

      // A follow-up stop() is a no-op (does not re-send SIGTERM).
      mockProc.kill.mockClear();
      await manager.stop();
      expect(mockProc.kill).not.toHaveBeenCalled();

      writeSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Unexpected-exit diagnostic
  // ---------------------------------------------------------------------------

  describe("unexpected-exit diagnostic", () => {
    it("fires exactly once on exit after start resolves, includes stderr tail", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await manager.start();
      mockProc.stderr.emit("data", Buffer.from("fatal: out of memory\n"));
      mockProc.emit("exit", 137, null);
      mockProc.emit("close", 137, null);

      const diagnostics = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith("[lionden]"));
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]).toContain("code 137");
      expect(diagnostics[0]).toContain("fatal: out of memory");

      writeSpy.mockRestore();
    });

    it("does NOT fire when stop() initiated the shutdown", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await manager.start();
      await manager.stop();

      const diagnostics = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith("[lionden]"));
      expect(diagnostics).toEqual([]);

      writeSpy.mockRestore();
    });

    it("does NOT fire on exit during start (before health-check passes)", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockRejectedValue(new Error("connection refused"));

      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      setTimeout(() => {
        mockProc.exitCode = 1;
        mockProc.emit("exit", 1, null);
        mockProc.emit("close", 1, null);
      }, 10);

      await expect(manager.start()).rejects.toThrow("Devnode exited");

      const diagnostics = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith("[lionden]"));
      expect(diagnostics).toEqual([]);

      writeSpy.mockRestore();
    });

    it("inherit mode diagnostic points to terminal logs", async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);
      mockFetch.mockResolvedValue({ ok: true });

      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await manager.start({ logMode: "inherit" });
      mockProc.emit("exit", 1, null);
      mockProc.emit("close", 1, null);

      const diagnostics = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith("[lionden]"));
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]).toContain("see terminal logs above");

      writeSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Restart cycle: per-process state must fully reset.
  // ---------------------------------------------------------------------------

  describe("restart cycle", () => {
    it("second start() resets exit promise, diagnostic flag, and log buffer", async () => {
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      // First life: clean stop.
      const proc1 = createMockProcess();
      vi.mocked(spawn).mockReturnValueOnce(proc1 as any);
      mockFetch.mockResolvedValue({ ok: true });
      await manager.start();
      proc1.stderr.emit("data", Buffer.from("first-run\n"));
      await manager.stop();

      // Second life: unexpected exit.
      const proc2 = createMockProcess();
      vi.mocked(spawn).mockReturnValueOnce(proc2 as any);
      await manager.start();
      proc2.stderr.emit("data", Buffer.from("second-run\n"));
      proc2.emit("exit", 137, null);
      proc2.emit("close", 137, null);

      // waitForExit resolves with the SECOND run's exit info, not stale 0.
      await expect(manager.waitForExit()).resolves.toEqual({
        code: 137,
        signal: null,
      });

      // Diagnostic fired exactly once (for the second run), not at all for the
      // first (which was a clean stop()).
      const diagnostics = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.startsWith("[lionden]"));
      expect(diagnostics.length).toBe(1);
      expect(diagnostics[0]).toContain("code 137");

      // getLogTail reflects ONLY the second run's chunks.
      expect(manager.getLogTail().stderr).toBe("second-run\n");
      expect(manager.getLogTail().stderr).not.toContain("first-run");

      writeSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Error message renders the buffered tail.
  // ---------------------------------------------------------------------------

  it("non-zero exit error includes buffered stderr tail", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockRejectedValue(new Error("connection refused"));

    setTimeout(() => {
      mockProc.stderr.emit("data", Buffer.from("fatal: out of memory\n"));
      mockProc.exitCode = 1;
      mockProc.emit("exit", 1, null);
      mockProc.emit("close", 1, null);
    }, 10);

    await expect(manager.start()).rejects.toThrow(/fatal: out of memory/);
  });

  it("non-zero exit error includes stderr drained after exit and before close", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockRejectedValue(new Error("connection refused"));

    setTimeout(() => {
      mockProc.exitCode = 1;
      mockProc.emit("exit", 1, null);
      mockProc.stderr.emit("data", Buffer.from("late fatal tail\n"));
      mockProc.emit("close", 1, null);
    }, 10);

    await expect(manager.start()).rejects.toThrow(/late fatal tail/);
  });

  // ---------------------------------------------------------------------------
  // Exit→close drain fallback: terminal state must not hang if `close` is
  // withheld (e.g. a grandchild keeps an inherited stdio pipe open).
  // ---------------------------------------------------------------------------

  it("terminal state resolves via the drain fallback when close is withheld", async () => {
    const mockProc = createMockProcess();
    // Emit `exit` but NOT `close`, simulating a grandchild holding a pipe open.
    mockProc.kill = vi.fn(() => {
      mockProc.exitCode = 0;
      mockProc.emit("exit", 0, null);
      return true;
    });
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start();
    expect(manager.isRunning()).toBe(true);

    // Scope fake timers to after a successful start so only the drain timer is
    // in play (health-check timers already ran with real timers).
    vi.useFakeTimers();
    try {
      const stopP = manager.stop();
      // `close` never fires; advance past the bounded grace (private constant,
      // hard-coded to 1_000 ms here) so the drain fallback forces terminal state.
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(stopP).resolves.toBeUndefined();
      expect(manager.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Standalone (aleo-devnode) backend
// ---------------------------------------------------------------------------

describe("DevnodeManager standalone backend", () => {
  let manager: DevnodeManager;

  beforeEach(() => {
    manager = new DevnodeManager();
    vi.clearAllMocks();
    delete process.env["LIONDEN_DEVNODE_LOGS"];
  });

  afterEach(async () => {
    await manager.stop();
  });

  it("spawns aleo-devnode with always-present --verbosity 0 and storage", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({
      provider: "standalone",
      devnodeBinary: "aleo-devnode",
      storagePath: "/tmp/ledger",
    });

    expect(spawn).toHaveBeenCalledWith(
      "aleo-devnode",
      [
        "start",
        "--verbosity",
        "0",
        "--private-key",
        "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
        "--storage",
        "/tmp/ledger",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(manager.provider).toBe("standalone");
    expect(manager.capabilities.snapshot).toBe(true);
  });

  it("never passes --network or --consensus-heights on standalone", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({
      provider: "standalone",
      autoBlock: false,
      verbosity: 2,
      socketAddr: "127.0.0.1:5050",
      storagePath: "/tmp/l",
      clearStorage: true,
    });

    const argv = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(argv).not.toContain("--network");
    expect(argv).not.toContain("--consensus-heights");
    expect(argv).toContain("--manual-block-creation");
    expect(argv).toContain("--clear-storage");
    expect(argv).toEqual(expect.arrayContaining(["--verbosity", "2"]));
    expect(argv).toEqual(expect.arrayContaining(["--socket-addr", "127.0.0.1:5050"]));
  });

  it("capabilities.snapshot is false without storagePath", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ provider: "standalone" });
    expect(manager.capabilities.snapshot).toBe(false);
  });

  it("rejects a non-testnet network on standalone (no silent coercion)", async () => {
    await expect(manager.start({ provider: "standalone", network: "mainnet" })).rejects.toThrow(
      /only supports the "testnet"/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects consensusHeights on standalone (no silent drop)", async () => {
    await expect(
      manager.start({ provider: "standalone", consensusHeights: "0,1,2" }),
    ).rejects.toThrow(/consensusHeights is not supported/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects clearStorage without storagePath before spawning", async () => {
    await expect(manager.start({ provider: "standalone", clearStorage: true })).rejects.toThrow(
      /clearStorage requires storagePath/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Snapshot / restore
// ---------------------------------------------------------------------------

describe("DevnodeManager snapshot/restore", () => {
  let manager: DevnodeManager;

  beforeEach(() => {
    manager = new DevnodeManager();
    vi.clearAllMocks();
    delete process.env["LIONDEN_DEVNODE_LOGS"];
  });

  afterEach(async () => {
    await manager.stop();
  });

  async function startStandalone(storagePath?: string): Promise<void> {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });
    await manager.start(
      storagePath !== undefined
        ? { provider: "standalone", storagePath }
        : { provider: "standalone" },
    );
    mockFetch.mockReset();
  }

  it("snapshot() throws on the leo backend", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockResolvedValue({ ok: true });
    await manager.start();
    await expect(manager.snapshot()).rejects.toThrow(/standalone/);
  });

  it("snapshot() throws when standalone has no storagePath", async () => {
    await startStandalone();
    await expect(manager.snapshot()).rejects.toThrow(/persistent storage/);
  });

  it("snapshot() posts {} when unnamed and {name} when named", async () => {
    await startStandalone("/tmp/l");

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: "snapshot-3", height: 3 }),
    });
    await manager.snapshot();
    expect(mockFetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:3030/testnet/snapshot",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );

    await manager.snapshot("mine");
    expect(mockFetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:3030/testnet/snapshot",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "mine" }) }),
    );
  });

  it("listSnapshots() GETs the snapshots endpoint", async () => {
    await startStandalone("/tmp/l");
    mockFetch.mockResolvedValue({ ok: true, json: async () => ["a", "b"] });
    await expect(manager.listSnapshots()).resolves.toEqual(["a", "b"]);
    expect(mockFetch).toHaveBeenLastCalledWith("http://127.0.0.1:3030/testnet/snapshots");
  });

  it("restore() stops, runs `restore`, then restarts", async () => {
    const order: string[] = [];
    vi.mocked(spawn).mockImplementation((_cmd: any, argv: any) => {
      const p = createMockProcess();
      if (Array.isArray(argv) && argv[0] === "restore") {
        order.push("restore");
        setTimeout(() => {
          p.emit("exit", 0, null);
          p.emit("close", 0, null);
        }, 0);
      } else {
        order.push("start");
      }
      return p as any;
    });
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ provider: "standalone", storagePath: "/tmp/l" });
    await manager.restore("snap");

    const restoreCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "restore");
    expect(restoreCall).toBeDefined();
    expect(restoreCall![0]).toBe("aleo-devnode");
    expect(restoreCall![1]).toEqual(["restore", "--snapshot", "snap", "--storage", "/tmp/l"]);
    // The default validator key used at start() must be forwarded via env.
    const env = (restoreCall![2] as { env: Record<string, string> }).env;
    expect(env["PRIVATE_KEY"]).toBe("APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH");
    expect(order).toEqual(["start", "restore", "start"]);
    expect(manager.isRunning()).toBe(true);
  });

  it("restore() works after a successful standalone start has stopped", async () => {
    const order: string[] = [];
    vi.mocked(spawn).mockImplementation((_cmd: any, argv: any) => {
      const p = createMockProcess();
      if (Array.isArray(argv) && argv[0] === "restore") {
        order.push("restore");
        setTimeout(() => {
          p.emit("exit", 0, null);
          p.emit("close", 0, null);
        }, 0);
      } else {
        order.push("start");
      }
      return p as any;
    });
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ provider: "standalone", storagePath: "/tmp/l" });
    await manager.stop();
    await manager.restore("snap");

    const restoreCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "restore");
    expect(restoreCall).toBeDefined();
    expect(restoreCall![1]).toEqual(["restore", "--snapshot", "snap", "--storage", "/tmp/l"]);
    expect(order).toEqual(["start", "restore", "start"]);
    expect(manager.isRunning()).toBe(true);
  });

  it("restore() does not re-clear storage on the post-restore restart", async () => {
    vi.mocked(spawn).mockImplementation((_cmd: any, argv: any) => {
      const p = createMockProcess();
      if (Array.isArray(argv) && argv[0] === "restore") {
        setTimeout(() => {
          p.emit("exit", 0, null);
          p.emit("close", 0, null);
        }, 0);
      }
      return p as any;
    });
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ provider: "standalone", storagePath: "/tmp/l", clearStorage: true });
    await manager.restore("snap");

    const startArgvs = vi
      .mocked(spawn)
      .mock.calls.map((c) => c[1] as string[])
      .filter((argv) => Array.isArray(argv) && argv[0] === "start");
    expect(startArgvs.length).toBe(2);
    // First start honors clearStorage; runRestoreCommand rebuilds the ledger, so
    // the post-restore restart must NOT re-emit --clear-storage (would wipe it).
    expect(startArgvs[0]).toContain("--clear-storage");
    expect(startArgvs[1]).not.toContain("--clear-storage");
  });

  it("restore() works after a successful standalone start exits unexpectedly", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const order: string[] = [];
    let firstStart: MockProc | undefined;
    vi.mocked(spawn).mockImplementation((_cmd: any, argv: any) => {
      const p = createMockProcess();
      if (Array.isArray(argv) && argv[0] === "restore") {
        order.push("restore");
        setTimeout(() => {
          p.emit("exit", 0, null);
          p.emit("close", 0, null);
        }, 0);
      } else {
        order.push("start");
        firstStart ??= p;
      }
      return p as any;
    });
    mockFetch.mockResolvedValue({ ok: true });

    await manager.start({ provider: "standalone", storagePath: "/tmp/l" });
    firstStart!.emit("exit", 1, null);
    firstStart!.emit("close", 1, null);

    await expect(manager.restore("snap")).resolves.toBeUndefined();

    const restoreCall = vi
      .mocked(spawn)
      .mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "restore");
    expect(restoreCall).toBeDefined();
    expect(restoreCall![1]).toEqual(["restore", "--snapshot", "snap", "--storage", "/tmp/l"]);
    expect(order).toEqual(["start", "restore", "start"]);
    expect(manager.isRunning()).toBe(true);

    writeSpy.mockRestore();
  });

  it("failed standalone start does not expose snapshot/restore state", async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);
    mockFetch.mockRejectedValue(new Error("connection refused"));

    setTimeout(() => {
      mockProc.exitCode = 1;
      mockProc.emit("exit", 1, null);
      mockProc.emit("close", 1, null);
    }, 10);

    await expect(manager.start({ provider: "standalone", storagePath: "/tmp/l" })).rejects.toThrow(
      "Devnode exited",
    );
    expect(manager.capabilities.snapshot).toBe(false);
    await expect(manager.restore("snap")).rejects.toThrow(
      "Cannot restore: devnode was never started.",
    );
  });
});
