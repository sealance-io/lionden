/**
 * SDK transport diagnostics — capture the underlying HTTP state-query failures
 * that the Provable SDK swallows behind opaque WASM errors.
 *
 * When the SDK proves an on-chain transaction (`pm.execute(...)`), its WASM
 * invokes JS state-query callbacks that call `AleoNetworkClient.getStatePaths()`
 * → `GET /<network>/statePaths?commitments=<cm>` through LionDen's guarded
 * transport. When the devnode answers `500 Commitment '<cm>' does not exist`,
 * the SDK throws, the rejection crosses the WASM→JS boundary, and wasm-bindgen
 * flattens it to `"JS callback Promise rejected:"` (empty suffix). The real
 * cause — the failing HTTP state query and its body — is otherwise invisible.
 *
 * This module gives the transport a place to record those failures
 * (`SdkDiagnostics`, a bounded ring buffer) and a wrapper (`captureSdkCall`)
 * around each SDK build/prove call site that drains the sink on throw and
 * re-throws a typed, descriptive {@link SdkExecutionError}.
 */

import { LocalExecutionWasmTrapError, SdkExecutionError } from "./types.js";

/**
 * One transport-level failure observed during an SDK build/prove call.
 * Either an HTTP non-OK response (status/statusText/bodyExcerpt populated) or a
 * thrown fetch / host-block (error populated).
 */
export interface SdkTransportFailure {
  /** HTTP method of the failed request (uppercased; defaults to GET). */
  readonly method: string;
  /** Full request URL. */
  readonly url: string;
  /** HTTP status code, when the failure was a non-OK response. */
  readonly status?: number;
  /** HTTP status text, when the failure was a non-OK response. */
  readonly statusText?: string;
  /** Response body, truncated to 512 chars, when the failure was a non-OK response. */
  readonly bodyExcerpt?: string;
  /** Error message, when the failure was a thrown fetch / egress block. */
  readonly error?: string;
  /** `Date.now()` timestamp when the failure was recorded. */
  readonly at: number;
}

const SDK_DIAGNOSTICS_RING_CAP = 16;

/**
 * Bounded ring buffer of transport failures, owned 1:1 by an SDK objects
 * bundle. The guarded network transport writes into it; `captureSdkCall`
 * clears it at entry and snapshots it on throw.
 *
 * Because the sink is shared by every transport call on its bundle (and public
 * `execute()` calls are not otherwise serialized), `runExclusive` serializes
 * overlapping `captureSdkCall` cycles so the clear-then-drain window is atomic
 * and each call's failures are attributed to the right call.
 */
export class SdkDiagnostics {
  private readonly failures: SdkTransportFailure[] = [];
  /** Tail of the per-sink serialization chain (a promise mutex). */
  private lock: Promise<void> = Promise.resolve();

  /** Record a transport failure, evicting the oldest once the cap is exceeded. */
  record(failure: SdkTransportFailure): void {
    this.failures.push(failure);
    if (this.failures.length > SDK_DIAGNOSTICS_RING_CAP) {
      this.failures.shift();
    }
  }

  /** Drop all recorded failures. */
  clear(): void {
    this.failures.length = 0;
  }

  /** Immutable copy of the currently-recorded failures, oldest first. */
  snapshot(): readonly SdkTransportFailure[] {
    return [...this.failures];
  }

  /**
   * Run `fn` with exclusive access to this sink — overlapping calls queue and
   * run one at a time, so a clear-then-drain cycle is never interleaved with
   * another call's. Not reentrant on the same sink (no caller nests it).
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Identifies the SDK call being wrapped so errors can name the operation. */
export interface SdkCallContext {
  readonly operation: "execute" | "local" | "deploy" | "upgrade";
  readonly programId: string;
  readonly transitionName?: string;
}

/**
 * Run an SDK build/prove call, capturing transport-level failures so an opaque
 * throw can be enriched into a descriptive {@link SdkExecutionError}.
 *
 * Runs under the sink's `runExclusive` mutex so overlapping calls don't cross
 * failures. Clears the sink at entry (so only failures from this call are
 * attributed), then awaits `fn`. On throw, snapshots the sink and:
 *   - **enriches** (wraps in `SdkExecutionError`) when EITHER a *state-query*
 *     failure was captured ({@link pickRelevantFailure} — the prove-path
 *     `/statePaths` / `/stateRoot` CallbackQuery) OR the error is an opaque
 *     WASM abort ({@link isOpaqueWasmError});
 *   - otherwise **re-throws unchanged** — a broadcast (`/transaction/broadcast`)
 *     or other non-state-query failure with a descriptive error is left alone,
 *     an already-descriptive error is not degraded, and an existing
 *     `SdkExecutionError` is never double-wrapped.
 */
export async function captureSdkCall<T>(
  diagnostics: SdkDiagnostics,
  context: SdkCallContext,
  fn: () => Promise<T>,
): Promise<T> {
  return diagnostics.runExclusive(async () => {
    diagnostics.clear();
    try {
      return await fn();
    } catch (error: unknown) {
      // Never double-wrap a previously-enriched error (defensive against nesting).
      if (error instanceof SdkExecutionError) {
        throw error;
      }
      // Pass a local-execution WASM trap through untouched. Its message contains
      // "unreachable", which isOpaqueWasmError would otherwise treat as an opaque
      // abort and re-wrap into a generic SdkExecutionError — burying the trap
      // class and message that local trap-capture callers assert on.
      if (error instanceof LocalExecutionWasmTrapError) {
        throw error;
      }
      const failures = diagnostics.snapshot();
      const relevant = pickRelevantFailure(failures);
      // Enrich only for the state-query (prove callback) failures this feature
      // exists to surface, or for an opaque WASM abort. A broadcast/other
      // failure with a descriptive error path passes through untouched.
      if (relevant === undefined && !isOpaqueWasmError(error)) {
        throw error;
      }
      throw new SdkExecutionError(buildSdkExecutionMessage(context, relevant, error), {
        operation: context.operation,
        programId: context.programId,
        transitionName: context.transitionName,
        diagnostics: failures,
        cause: error,
      });
    }
  });
}

/**
 * Choose the state-query failure most likely to be the prove-path root cause:
 * the last `/statePaths` failure (the inclusion-proof query), else the last
 * `/stateRoot` failure. Returns `undefined` when no state-query failure was
 * captured — deliberately NOT falling back to an arbitrary last entry, so a
 * `/transaction/broadcast` or other non-state-query failure is never mislabeled
 * as a build/prove state query.
 */
export function pickRelevantFailure(
  failures: readonly SdkTransportFailure[],
): SdkTransportFailure | undefined {
  for (const needle of ["/statePaths", "/stateRoot"]) {
    for (let i = failures.length - 1; i >= 0; i--) {
      if (failures[i]!.url.includes(needle)) return failures[i];
    }
  }
  return undefined;
}

/**
 * Whether `error` is an opaque WASM abort with no usable cause of its own —
 * the wasm-bindgen `"JS callback Promise rejected:"` flattening, a
 * `RuntimeError`/`unreachable` trap, or a non-`Error` thrown value with no
 * meaningful message. These are the cases worth enriching even when the sink
 * happens to be empty.
 */
export function isOpaqueWasmError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message ?? "";
    return (
      message.includes("JS callback Promise rejected") ||
      error.name === "RuntimeError" ||
      message.includes("unreachable")
    );
  }
  // Non-Error thrown value (raw WASM aborts often throw these). Treat as opaque
  // when it carries no usable message string.
  const message = errorMessage(error).trim();
  return message.length === 0 || message === "[object Object]";
}

function buildSdkExecutionMessage(
  context: SdkCallContext,
  failure: SdkTransportFailure | undefined,
  error: unknown,
): string {
  const subject = context.transitionName
    ? `${context.programId}/${context.transitionName}`
    : context.programId;
  const parts: string[] = [`${subject} ${context.operation} failed during SDK build/prove.`];

  if (failure === undefined) {
    parts.push("WASM aborted without a descriptive error and no state-query failure was recorded.");
  } else if (failure.status !== undefined) {
    const statusText = failure.statusText ? ` ${failure.statusText}` : "";
    const body = failure.bodyExcerpt ? `: ${failure.bodyExcerpt}` : "";
    parts.push(
      `State query ${failure.method} ${failure.url} -> ${failure.status}${statusText}${body}.`,
    );
  } else {
    parts.push(
      `State query ${failure.method} ${failure.url} failed: ${failure.error ?? "unknown error"}.`,
    );
  }

  parts.push(`Cause: ${errorMessage(error)}`);
  return parts.join(" ");
}

/** One-line error-to-string helper (mirrors the one in connection.ts). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
