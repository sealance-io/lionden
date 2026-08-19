/**
 * Running the Leo CLI.
 *
 * `spawn`, not `execFile`, and deliberately so: key synthesis for a large
 * program can run for tens of minutes, so the user needs streamed progress or
 * it looks like the very hang this backend exists to avoid, and `execFile`'s
 * 1 MB `maxBuffer` would truncate or error on verbose Leo output. Modelled on
 * `DevnodeManager`, including its ring-buffered tail and SIGTERM-then-SIGKILL
 * escalation.
 *
 * The runner is an injectable function type so the backend can be tested
 * against a fake without spawning anything.
 */

import { spawn } from "node:child_process";
import type { DeployLeoLogMode } from "@lionden/config";
import { createStreamRedactor } from "@lionden/core";

/** Matches `LOG_TAIL_RENDER_BYTES` in `devnode-manager.ts`. */
const LOG_TAIL_BYTES = 4 * 1024;
/** Grace period between SIGTERM and SIGKILL, matching `DevnodeManager`. */
const KILL_ESCALATION_MS = 5_000;

export interface LeoRunRequest {
  readonly binary: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** From `deploy.leo.timeout`. `0` disables. */
  readonly timeoutMs: number;
  readonly logMode: DeployLeoLogMode;
  /**
   * Secrets to redact in addition to anything matching the private-key
   * grammar — in practice the signing key, which is passed via `env` and so
   * should never appear, but is included because "should never" is not a
   * guarantee about a third-party binary's output.
   */
  readonly secrets: readonly string[];
}

export interface LeoRunResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Redacted tail of stdout. */
  readonly stdout: string;
  /** Redacted tail of stderr. */
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type LeoRunner = (request: LeoRunRequest) => Promise<LeoRunResult>;

/**
 * Bounded tail that only ever holds redacted text.
 *
 * Redaction happens on the way *in*, not on the way out, so a secret can never
 * be split across the eviction boundary and survive: by the time anything is
 * stored it has already passed the stream redactor.
 */
class RedactedTail {
  private buffer = "";
  private readonly redactor;

  constructor(
    secrets: readonly string[],
    private readonly forward: ((text: string) => void) | null,
  ) {
    this.redactor = createStreamRedactor(secrets);
  }

  push(chunk: string): void {
    this.emit(this.redactor.push(chunk));
  }

  finish(): string {
    this.emit(this.redactor.flush());
    return this.buffer;
  }

  private emit(text: string): void {
    if (text.length === 0) return;
    this.forward?.(text);
    this.buffer = (this.buffer + text).slice(-LOG_TAIL_BYTES);
  }
}

/**
 * The real runner.
 *
 * `stdio` is always piped. `logMode: "inherit"` is not offered precisely
 * because inherited stdio is wired to the parent's file descriptors and never
 * passes through JS, so redaction could not be applied to it.
 */
export const spawnLeoRunner: LeoRunner = (request) =>
  new Promise<LeoRunResult>((resolve, reject) => {
    const forwarding = request.logMode === "forward";
    const out = new RedactedTail(
      request.secrets,
      forwarding ? (text) => process.stdout.write(text) : null,
    );
    const err = new RedactedTail(
      request.secrets,
      forwarding ? (text) => process.stderr.write(text) : null,
    );

    const child = spawn(request.binary, [...request.argv], {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    if (request.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATION_MS);
      }, request.timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => out.push(chunk));
    child.stderr?.on("data", (chunk: string) => err.push(chunk));

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on("error", (error) => {
      cleanup();
      out.finish();
      err.finish();
      reject(error);
    });

    child.on("close", (code, signal) => {
      cleanup();
      resolve({
        exitCode: code,
        signal,
        stdout: out.finish(),
        stderr: err.finish(),
        timedOut,
      });
    });
  });
