/**
 * Secret redaction for subprocess output.
 *
 * The Leo deploy backend forwards a child process's stdout/stderr to the user
 * and embeds a tail of it in error messages. That output can carry an Aleo
 * private key — Leo echoes a truncated one into its own deployment plan
 * summary, and a misconfigured invocation could echo a full one — so every byte
 * that leaves the runner passes through here first.
 *
 * Two entry points, deliberately sharing one implementation so they can never
 * disagree: `redactSecrets` for a complete string, and `createStreamRedactor`
 * for a byte stream arriving in arbitrary chunks.
 */

/** Prefix of every Aleo private key. */
const MARKER = "APrivateKey1";

/**
 * Alphanumerics after `MARKER` before a token is certainly a key.
 *
 * Real keys carry 47-ish; 40 is the conservative floor already used by the
 * `/APrivateKey1[A-Za-z0-9]{40,}/` shape this replaces.
 */
const KEY_TAIL_MIN = 40;

/**
 * How Leo renders a private key it has decided not to print in full: the first
 * 24 characters of the key followed by an ellipsis, e.g.
 * `APrivateKey1zkp8CZNn3yeC...` in its deployment plan summary.
 *
 * That is real key material — 12 characters of it — so it is redacted too. It
 * cannot reach `KEY_TAIL_MIN`, so the certainty threshold alone would emit it
 * verbatim; this suffix is the second, independent reason to redact a
 * `MARKER`-prefixed token.
 */
const TRUNCATION_SUFFIX = "...";

export const REDACTED = "[REDACTED]";

/**
 * Streaming redactor.
 *
 * `push` returns the portion of the stream that is safe to emit *now*; `flush`
 * returns whatever was held back once the stream ends. Callers must emit both,
 * in order, and must not emit the raw chunk.
 *
 * A naive per-chunk regex leaks, because chunk boundaries are arbitrary: a key
 * split across two chunks matches in neither. A fixed trailing window does not
 * fix it either — `APrivateKey1[A-Za-z0-9]{40,}` has no upper bound, so no
 * constant carry-over is provably safe. Hence a small state machine:
 *
 * - **scanning** — emit freely, holding back only a suffix that is a proper
 *   prefix of a needle. That window *is* bounded: `maxNeedleLength - 1`.
 * - **candidate** — `MARKER` seen; buffer and count trailing alphanumerics. Two
 *   things end it as a redaction: the 40th alphanumeric, or a `...` that closes
 *   a shorter run, which is how Leo renders a truncated key.
 * - **discarding** — the 40th alphanumeric arrived, so this is certainly a key:
 *   the replacement has been emitted and every further alphanumeric is dropped.
 *
 * The discarding state is what keeps this both safe and cheap. Deciding at
 * character 40 rather than at the token's end bounds the candidate buffer at
 * `len(MARKER) + 39 = 51` bytes, so there is no size cap to overflow and no
 * "resume mid-key" transition that would emit a key's tail verbatim.
 */
export interface StreamRedactor {
  /** Redacted, safely-emittable prefix of everything pushed so far. */
  push(chunk: string): string;
  /** Held-back remainder. Call once, at end of stream. */
  flush(): string;
}

type State = "scanning" | "candidate" | "discarding";

export function createStreamRedactor(extra?: readonly string[]): StreamRedactor {
  // Longest first so an extra secret that contains another is replaced whole.
  // Anything shorter than the marker would over-match ordinary output.
  const secrets = [...new Set((extra ?? []).filter((s) => s.length >= 8))].sort(
    (a, b) => b.length - a.length,
  );
  const needles = [...secrets, MARKER];
  const maxNeedle = Math.max(...needles.map((n) => n.length));

  let buf = "";
  let candidate = "";
  let alnumSeen = 0;
  let state: State = "scanning";

  /** Longest needle starting at `i`, or null. Secrets win over the marker. */
  function needleAt(i: number): string | null {
    for (const n of needles) {
      if (buf.startsWith(n, i)) return n;
    }
    return null;
  }

  /**
   * Could a needle begin at `i` and continue past the end of what we hold? Only
   * asked near the tail, so the slice stays short.
   */
  function mayStartNeedle(i: number): boolean {
    const rest = buf.slice(i);
    return needles.some((n) => n.length > rest.length && n.startsWith(rest));
  }

  /** Is what we hold from `i` a proper prefix of `TRUNCATION_SUFFIX`? */
  function startsTruncation(i: number): boolean {
    return TRUNCATION_SUFFIX.startsWith(buf.slice(i));
  }

  function drain(atEnd: boolean): string {
    let out = "";
    let i = 0;

    while (i < buf.length) {
      if (state === "scanning") {
        const hit = needleAt(i);
        if (hit === null) {
          // Hold back a partial needle so the next chunk can complete it.
          if (!atEnd && buf.length - i < maxNeedle && mayStartNeedle(i)) break;
          out += buf[i];
          i += 1;
          continue;
        }
        if (hit !== MARKER) {
          out += REDACTED;
          i += hit.length;
          continue;
        }
        state = "candidate";
        candidate = MARKER;
        alnumSeen = 0;
        i += MARKER.length;
        continue;
      }

      if (state === "candidate") {
        const ch = buf[i]!;
        if (isAlnum(ch)) {
          candidate += ch;
          alnumSeen += 1;
          i += 1;
          if (alnumSeen >= KEY_TAIL_MIN) {
            out += REDACTED;
            candidate = "";
            state = "discarding";
          }
          continue;
        }
        // Fewer than 40 trailing alphanumerics, so not certainly a key — unless
        // Leo truncated it, which it signals with a trailing `...`. Deciding
        // that needs up to three characters of lookahead, so hold back for them
        // rather than guessing from what has arrived so far.
        if (alnumSeen > 0) {
          if (!atEnd && buf.length - i < TRUNCATION_SUFFIX.length && startsTruncation(i)) break;
          if (buf.startsWith(TRUNCATION_SUFFIX, i)) {
            // Replace the whole rendering, ellipsis included: `[REDACTED]...`
            // would read as a formatting artifact rather than a redaction.
            out += REDACTED;
            i += TRUNCATION_SUFFIX.length;
            candidate = "";
            state = "scanning";
            continue;
          }
        }

        // Not a key and not a truncated key. Emit verbatim and re-examine this
        // delimiter in the scanning state.
        out += candidate;
        candidate = "";
        state = "scanning";
        continue;
      }

      // discarding
      if (isAlnum(buf[i]!)) {
        i += 1;
        continue;
      }
      state = "scanning";
    }

    buf = buf.slice(i);
    return out;
  }

  return {
    push(chunk: string): string {
      if (chunk.length === 0) return "";
      buf += chunk;
      return drain(false);
    },
    flush(): string {
      let out = drain(true);
      // A candidate that reached end-of-stream neither hit 40 alphanumerics nor
      // closed with `...`, so it was neither a key nor Leo's truncated
      // rendering of one. A discarding run emits nothing more.
      if (state === "candidate") {
        out += candidate;
        candidate = "";
      }
      state = "scanning";
      buf = "";
      return out;
    },
  };
}

/**
 * Redact a complete string.
 *
 * Implemented over `createStreamRedactor` rather than a parallel regex so the
 * one-shot and streaming paths cannot drift apart.
 */
export function redactSecrets(text: string, extra?: readonly string[]): string {
  const redactor = createStreamRedactor(extra);
  return redactor.push(text) + redactor.flush();
}

function isAlnum(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}
