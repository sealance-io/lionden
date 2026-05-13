/**
 * DevnodeManager — manages the lifecycle of a `leo devnode start` process.
 *
 * Handles spawning, health-checking, and graceful shutdown.
 */

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import type { DevnodeLogMode, DevnodeStartOptions } from "./types.js";

const DEFAULT_SOCKET_ADDR = "127.0.0.1:3030";
const DEFAULT_PRIVATE_KEY =
  "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";
const HEALTH_CHECK_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const LOG_BUFFER_BYTES = 64 * 1024;
const LOG_TAIL_RENDER_BYTES = 4 * 1024;

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };

type LogCallbacks = {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
};

/**
 * Bounded byte ring buffer backed by a list of chunks. Trims the oldest bytes
 * (slicing the head chunk if needed) until total bytes ≤ `maxBytes`.
 */
class RingBuffer {
  private chunks: Buffer[] = [];
  private byteLength = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
    while (this.byteLength > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const overflow = this.byteLength - this.maxBytes;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.byteLength -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.byteLength -= overflow;
      }
    }
  }

  toString(): string {
    if (this.chunks.length === 0) return "";
    return Buffer.concat(this.chunks, this.byteLength).toString("utf8");
  }
}

/** Map a `DevnodeLogMode` to the corresponding `spawn` stdio array. */
export function stdioConfigForMode(logMode: DevnodeLogMode): StdioOptions {
  if (logMode === "inherit") return ["ignore", "inherit", "inherit"];
  return ["ignore", "pipe", "pipe"];
}

/**
 * Attach drain listeners to the child's piped streams per `logMode`. Owns the
 * internal ring buffers; returns a handle whose `getTail()` produces the
 * current buffered tail (≤ 64 KiB per stream). For `logMode: "inherit"`
 * returns an empty-tail handle without touching the streams.
 */
export function setupChildLogging(
  proc: ChildProcess,
  logMode: DevnodeLogMode,
  callbacks?: LogCallbacks,
): { getTail(): { stdout: string; stderr: string } } {
  if (logMode === "inherit") {
    return { getTail: () => ({ stdout: "", stderr: "" }) };
  }
  const stdoutBuf = new RingBuffer(LOG_BUFFER_BYTES);
  const stderrBuf = new RingBuffer(LOG_BUFFER_BYTES);
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf.append(chunk);
    if (logMode === "forward") callbacks?.onStdout?.(chunk);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf.append(chunk);
    if (logMode === "forward") callbacks?.onStderr?.(chunk);
  });
  return {
    getTail: () => ({
      stdout: stdoutBuf.toString(),
      stderr: stderrBuf.toString(),
    }),
  };
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null && code !== null) return `code ${code} signal ${signal}`;
  if (signal !== null) return `signal ${signal}`;
  return `code ${code ?? "null"}`;
}

function resolveLogMode(opts: DevnodeStartOptions): {
  mode: DevnodeLogMode;
  callbacks?: LogCallbacks;
} {
  if (opts.logMode !== undefined) {
    return {
      mode: opts.logMode,
      callbacks:
        opts.onStdout || opts.onStderr
          ? { onStdout: opts.onStdout, onStderr: opts.onStderr }
          : undefined,
    };
  }
  const env = process.env["LIONDEN_DEVNODE_LOGS"];
  if (env === "1" || env === "inherit") return { mode: "inherit" };
  if (env === "forward") {
    const def = (chunk: Buffer) =>
      process.stderr.write(`[devnode] ${chunk.toString("utf8")}`);
    return { mode: "forward", callbacks: { onStdout: def, onStderr: def } };
  }
  return { mode: "quiet-buffered" };
}

export class DevnodeManager {
  private process: ChildProcess | null = null;
  private _endpoint = "";
  private _logMode: DevnodeLogMode = "quiet-buffered";
  private _logging?: { getTail(): { stdout: string; stderr: string } };
  private _exitPromise?: Promise<ExitInfo>;
  private _exitResolve?: (info: ExitInfo) => void;
  private _terminal = false;
  private _exitInfo?: ExitInfo;
  private _shutdownInitiated = false;
  private _startResolved = false;
  private _diagnosticEmitted = false;
  private _spawnErrorMessage?: string;

  /** REST API endpoint URL (e.g., "http://127.0.0.1:3030") */
  get endpoint(): string {
    return this._endpoint;
  }

  /** Whether the devnode process is currently running. */
  isRunning(): boolean {
    return this.process !== null;
  }

  /** Snapshot of buffered child output. Empty strings for `inherit` mode. */
  getLogTail(): { stdout: string; stderr: string } {
    return this._logging?.getTail() ?? { stdout: "", stderr: "" };
  }

  /**
   * Resolves with the child's terminal exit info. Resolves on `exit`, or — if
   * the child fires `error` without ever firing `exit` — with
   * `{ code: null, signal: null }`. Throws synchronously if called before
   * `start()`. Idempotent: every call after termination receives the same info.
   */
  waitForExit(): Promise<ExitInfo> {
    if (!this._exitPromise) {
      throw new Error("DevnodeManager has not been started");
    }
    return this._exitPromise;
  }

  /**
   * Start a devnode process with the given options.
   * Waits for the REST API to become healthy before returning.
   */
  async start(options: DevnodeStartOptions = {}): Promise<void> {
    if (this.isRunning()) {
      throw new Error("Devnode is already running. Call stop() first.");
    }

    this.resetPerProcessState();

    const { mode, callbacks } = resolveLogMode(options);
    this._logMode = mode;

    const socketAddr = options.socketAddr ?? DEFAULT_SOCKET_ADDR;
    this._endpoint = `http://${socketAddr}`;

    const args = this.buildArgs(options);
    const network = options.network ?? "testnet";
    const leoBinary = options.leoBinary ?? "leo";

    const proc = spawn(
      leoBinary,
      ["--disable-update-check", "devnode", "start", ...args],
      { stdio: stdioConfigForMode(mode) },
    );
    this.process = proc;
    this._logging = setupChildLogging(proc, mode, callbacks);

    proc.once("exit", (code, signal) => {
      this.markTerminal(code ?? null, signal ?? null);
    });
    proc.once("error", (err) => {
      this._spawnErrorMessage =
        `Failed to start devnode: ${err.message}. ` +
        `Ensure the Leo CLI ("${leoBinary}") is installed and accessible.`;
      if (!this._terminal) this.markTerminal(null, null);
    });

    // `earlyExitSignal` resolves (never rejects) when the child exits. Used by
    // the start-time race to detect a pre-health-check death. Designed to
    // never reject so a later exit from a normal `stop()` can't surface as an
    // unhandled rejection.
    const earlyExitSignal = this._exitPromise!.then(() => undefined);

    const healthCheck = this.waitForHealthy(network);

    try {
      await Promise.race([healthCheck, earlyExitSignal]);
    } catch (err) {
      // healthCheck rejected (e.g., timeout).
      await this.stop();
      throw err;
    }

    const exitInfo = this._exitInfo;
    if (exitInfo) {
      if (this._shutdownInitiated) {
        // Caller invoked stop() while start() was still racing. Honor the
        // abort silently — they've already signaled they don't care about
        // start's outcome.
        return;
      }
      if (this._spawnErrorMessage) {
        throw new Error(this._spawnErrorMessage);
      }
      throw new Error(this.renderExitError(exitInfo.code, exitInfo.signal));
    }

    this._startResolved = true;
  }

  /**
   * Stop the devnode process gracefully.
   * Sends SIGTERM, then SIGKILL after a timeout. Awaits the canonical exit
   * event before returning so `markTerminal` is the sole writer of
   * `this.process`.
   */
  async stop(): Promise<void> {
    if (!this.process) return;
    this._shutdownInitiated = true;
    const proc = this.process;
    const exitP = this._exitPromise!;
    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, SHUTDOWN_TIMEOUT_MS);
    proc.kill("SIGTERM");
    await exitP;
    clearTimeout(killTimer);
  }

  /** Reset all per-process state so a stop/start cycle is clean. */
  private resetPerProcessState(): void {
    this._terminal = false;
    this._exitInfo = undefined;
    this._shutdownInitiated = false;
    this._startResolved = false;
    this._diagnosticEmitted = false;
    this._spawnErrorMessage = undefined;
    this._logging = undefined;
    this._exitPromise = new Promise<ExitInfo>((resolve) => {
      this._exitResolve = resolve;
    });
  }

  /** Idempotent: collapse exit/error events into a single terminal state. */
  private markTerminal(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this._terminal) return;
    this._terminal = true;
    this._exitInfo = { code, signal };
    this.process = null;
    this._exitResolve?.({ code, signal });

    if (
      this._startResolved &&
      !this._shutdownInitiated &&
      !this._diagnosticEmitted
    ) {
      this._diagnosticEmitted = true;
      this.emitUnexpectedExitDiagnostic(code, signal);
    }
  }

  private emitUnexpectedExitDiagnostic(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const exitFormatted = formatExit(code, signal);
    if (this._logMode === "inherit") {
      process.stderr.write(
        `[lionden] devnode exited unexpectedly (${exitFormatted}) — see terminal logs above\n`,
      );
      return;
    }
    const tail = this.getLogTail().stderr.slice(-LOG_TAIL_RENDER_BYTES);
    const suffix = tail.length > 0 ? (tail.endsWith("\n") ? tail : `${tail}\n`) : "";
    process.stderr.write(
      `[lionden] devnode exited unexpectedly (${exitFormatted}):\n${suffix}`,
    );
  }

  private renderExitError(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): string {
    const exitFormatted = formatExit(code, signal);
    if (this._logMode === "inherit") {
      return `Devnode exited (${exitFormatted}). (logs were inherited to terminal)`;
    }
    const tail = this.getLogTail().stderr.slice(-LOG_TAIL_RENDER_BYTES);
    return tail.length > 0
      ? `Devnode exited (${exitFormatted}).\n${tail}`
      : `Devnode exited (${exitFormatted}).`;
  }

  /** Build CLI arguments for `leo devnode start`. */
  private buildArgs(options: DevnodeStartOptions): string[] {
    const args: string[] = [];

    const socketAddr = options.socketAddr ?? DEFAULT_SOCKET_ADDR;
    if (socketAddr !== DEFAULT_SOCKET_ADDR) {
      args.push("--socket-addr", socketAddr);
    }

    if (options.autoBlock === false) {
      args.push("--manual-block-creation");
    }

    if (options.verbosity !== undefined && options.verbosity > 0) {
      args.push("--verbosity", String(options.verbosity));
    }

    if (options.genesisPath) {
      args.push("--genesis-path", options.genesisPath);
    }

    if (options.network && options.network !== "testnet") {
      args.push("--network", options.network);
    }

    args.push("--private-key", options.privateKey ?? DEFAULT_PRIVATE_KEY);

    if (options.consensusHeights) {
      args.push("--consensus-heights", options.consensusHeights);
    }

    return args;
  }

  /** Poll the REST API until it responds or timeout. */
  private async waitForHealthy(network: string): Promise<void> {
    const url = `${this._endpoint}/${network}/block/height/latest`;
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
      } catch {
        // Not ready yet
      }
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }

    const tail = this.getLogTail().stderr.slice(-LOG_TAIL_RENDER_BYTES);
    const suffix = tail.length > 0 ? `\n${tail}` : "";
    throw new Error(
      `Devnode health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms. ` +
        `Expected REST API at ${url}${suffix}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
