import { describe, expect, it } from "vitest";
import { createStreamRedactor, REDACTED, redactSecrets } from "./redact.js";

/** A realistic key: the marker plus 47 alphanumerics. */
const KEY = "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";
/** Marker + exactly 39 alphanumerics — one short of the certainty threshold. */
const NEAR_MISS = `APrivateKey1${"a".repeat(39)}`;

/** Feed `text` through the redactor in fixed-size chunks. */
function pushInChunks(text: string, size: number, extra?: readonly string[]): string {
  const r = createStreamRedactor(extra);
  let out = "";
  for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size));
  return out + r.flush();
}

/** Feed `text` split at exactly one offset. */
function pushSplitAt(text: string, at: number, extra?: readonly string[]): string {
  const r = createStreamRedactor(extra);
  return r.push(text.slice(0, at)) + r.push(text.slice(at)) + r.flush();
}

describe("redactSecrets", () => {
  it("replaces a private key", () => {
    expect(redactSecrets(`key=${KEY} rest`)).toBe(`key=${REDACTED} rest`);
  });

  it("leaves ordinary text untouched", () => {
    const text = "Deploying spike_a.aleo\n  Total Fee: 1001.010041\n";
    expect(redactSecrets(text)).toBe(text);
  });

  it("replaces every occurrence", () => {
    expect(redactSecrets(`${KEY} and ${KEY}`)).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it("replaces a caller-supplied secret", () => {
    expect(redactSecrets("token=hunter2000 ok", ["hunter2000"])).toBe(`token=${REDACTED} ok`);
  });

  it("ignores supplied secrets too short to be worth matching", () => {
    // An 8-char floor keeps a secret like "1" from redacting every digit in a
    // fee breakdown.
    expect(redactSecrets("cost 1 of 2", ["1"])).toBe("cost 1 of 2");
  });

  /**
   * Leo prints the key truncated to 24 characters in its deployment plan
   * summary — 12 characters of real key material past the marker. It is far
   * short of the 40-alphanumeric certainty threshold, so only the `...` suffix
   * identifies it, and without that rule it would be forwarded verbatim.
   */
  it("redacts Leo's truncated plan-summary rendering", () => {
    expect(redactSecrets("  Private Key:        APrivateKey1zkp8CZNn3yeC...")).toBe(
      `  Private Key:        ${REDACTED}`,
    );
  });

  it("redacts the truncated rendering mid-line, leaving the rest intact", () => {
    expect(redactSecrets("using APrivateKey1zkp8CZNn3yeC... to deploy")).toBe(
      `using ${REDACTED} to deploy`,
    );
  });

  /**
   * The path the reviewer walked: supplying the full key as an extra secret does
   * nothing for the truncated form, because the printed text is a prefix of the
   * secret rather than the secret. The marker rule is what has to catch it.
   */
  it("redacts the truncated rendering even when the full key is a supplied secret", () => {
    const out = redactSecrets(`Private Key: ${KEY.slice(0, 24)}...`, [KEY]);
    expect(out).toBe(`Private Key: ${REDACTED}`);
    expect(out).not.toContain("zkp8CZ");
  });

  /**
   * `APrivateKey1...` with nothing between marker and ellipsis is a placeholder
   * carrying no key material, so there is nothing to redact.
   */
  it("leaves a bare marker placeholder alone", () => {
    expect(redactSecrets("pass APrivateKey1... to --private-key")).toBe(
      "pass APrivateKey1... to --private-key",
    );
  });

  it("does not treat a shorter run of dots as a truncation", () => {
    expect(redactSecrets("APrivateKey1zkp8CZ..next")).toBe("APrivateKey1zkp8CZ..next");
  });

  it("emits a near-miss token verbatim", () => {
    expect(redactSecrets(`x ${NEAR_MISS} y`)).toBe(`x ${NEAR_MISS} y`);
  });

  it("redacts a key terminated by end of input rather than a delimiter", () => {
    expect(redactSecrets(`trailing ${KEY}`)).toBe(`trailing ${REDACTED}`);
  });
});

describe("createStreamRedactor", () => {
  /**
   * The whole reason this is a state machine: a key split across a chunk
   * boundary matches no per-chunk regex. Every offset, not a sampled few.
   */
  it("redacts a key split across two chunks at every offset", () => {
    const text = `before ${KEY} after`;
    for (let at = 0; at <= text.length; at++) {
      expect(pushSplitAt(text, at), `split at ${at}`).toBe(`before ${REDACTED} after`);
    }
  });

  it("redacts a key split across many chunks, including one byte at a time", () => {
    const text = `before ${KEY} after`;
    for (const size of [1, 2, 3, 5, 7, 13]) {
      expect(pushInChunks(text, size), `chunk size ${size}`).toBe(`before ${REDACTED} after`);
    }
  });

  it("redacts a caller-supplied secret split across chunks at every offset", () => {
    const secret = "s3cret-value-long-enough";
    const text = `auth ${secret} done`;
    for (let at = 0; at <= text.length; at++) {
      expect(pushSplitAt(text, at, [secret]), `split at ${at}`).toBe(`auth ${REDACTED} done`);
    }
  });

  /**
   * The failure mode an earlier design had: bounding the candidate buffer and
   * "resuming" on overflow re-enters scanning mid-key, emitting the rest of the
   * key verbatim. Deciding at character 40 means nothing past the replacement
   * is ever emitted, however long the token runs.
   */
  it("emits not one character past the replacement for an over-long token", () => {
    const overlong = `APrivateKey1${"Z".repeat(500)}`;
    const out = pushInChunks(`[${overlong}]`, 7);
    expect(out).toBe(`[${REDACTED}]`);
    expect(out).not.toContain("Z");
  });

  it("holds back nothing once the stream ends", () => {
    const r = createStreamRedactor();
    const pushed = r.push("plain text with no secret");
    expect(pushed + r.flush()).toBe("plain text with no secret");
  });

  /**
   * The truncation rule needs three characters of lookahead, so a chunk that
   * ends inside the ellipsis must be held back — otherwise the prefix is
   * already emitted by the time the `...` proving it is a key arrives.
   */
  it("redacts the truncated rendering split across two chunks at every offset", () => {
    const text = "Private Key: APrivateKey1zkp8CZNn3yeC... done";
    for (let at = 0; at <= text.length; at++) {
      expect(pushSplitAt(text, at), `split at ${at}`).toBe(`Private Key: ${REDACTED} done`);
    }
  });

  it("redacts the truncated rendering one byte per chunk", () => {
    expect(pushInChunks("k=APrivateKey1zkp8CZNn3yeC...!", 1)).toBe(`k=${REDACTED}!`);
  });

  it("emits a near-miss verbatim when the stream ends mid-candidate", () => {
    const r = createStreamRedactor();
    const out = r.push(NEAR_MISS) + r.flush();
    expect(out).toBe(NEAR_MISS);
  });

  it("emits nothing further when the stream ends mid-key", () => {
    const r = createStreamRedactor();
    const out = r.push(KEY) + r.flush();
    expect(out).toBe(REDACTED);
  });

  /**
   * Guards the held-back window. A chunk ending in a proper prefix of the
   * marker must not be emitted yet, or the next chunk completes a key that was
   * already partly written out.
   */
  it("does not emit a partial marker before the rest of it arrives", () => {
    const r = createStreamRedactor();
    const first = r.push("value=APrivate");
    expect(first).toBe("value=");
    const second = r.push(`Key1${KEY.slice(MARKER_LEN)} tail`);
    expect(first + second + r.flush()).toBe(`value=${REDACTED} tail`);
  });

  it("releases a held-back partial marker that turns out to be ordinary text", () => {
    const r = createStreamRedactor();
    const out = r.push("APrivate") + r.push("Sale") + r.flush();
    expect(out).toBe("APrivateSale");
  });

  it("is reusable after flush", () => {
    const r = createStreamRedactor();
    r.push(KEY);
    r.flush();
    expect(r.push("clean") + r.flush()).toBe("clean");
  });
});

const MARKER_LEN = "APrivateKey1".length;
