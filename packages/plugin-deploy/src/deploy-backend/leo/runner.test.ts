/**
 * The spawn wrapper, exercised against a real child process.
 *
 * A fake `spawn` would not prove the things that matter here — that redaction
 * is applied to genuinely arbitrary chunk boundaries, and that the timeout
 * actually kills a process that ignores SIGTERM — so these drive `node -e`
 * instead. They are fast (well under a second each) and need no Leo binary.
 */

import { REDACTED } from "@lionden/core";
import { loadLeoCliCapture } from "@lionden/test-internals";
import { describe, expect, it } from "vitest";
import { type LeoRunRequest, spawnLeoRunner } from "./runner.js";

const KEY = "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";

function run(script: string, over: Partial<LeoRunRequest> = {}) {
  return spawnLeoRunner({
    binary: process.execPath,
    argv: ["-e", script],
    env: { ...process.env },
    cwd: process.cwd(),
    timeoutMs: 0,
    logMode: "quiet-buffered",
    secrets: [],
    ...over,
  });
}

describe("spawnLeoRunner", () => {
  it("reports a clean exit and captures both streams", async () => {
    const result = await run(
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(0);',
    );
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("reports a non-zero exit code", async () => {
    const result = await run("process.exit(213);");
    expect(result.exitCode).toBe(213);
  });

  it("passes the environment through to the child", async () => {
    const result = await run('process.stdout.write(process.env.PROBE ?? "unset");', {
      env: { ...process.env, PROBE: "carried" },
    });
    expect(result.stdout).toBe("carried");
  });

  describe("redaction", () => {
    it("redacts a private key in stdout", async () => {
      const result = await run(`process.stdout.write("key=${KEY}\\n");`);
      expect(result.stdout).toBe(`key=${REDACTED}\n`);
      expect(result.stdout).not.toContain("APrivateKey1zkp8");
    });

    it("redacts a private key in stderr", async () => {
      const result = await run(`process.stderr.write("key=${KEY}\\n");`);
      expect(result.stderr).toBe(`key=${REDACTED}\n`);
    });

    /**
     * The real hazard: the child writes a key one byte at a time, so no single
     * `data` event contains it. Per-chunk matching would emit the whole key.
     */
    it("redacts a key written one byte per chunk", async () => {
      const script = `for (const c of ${JSON.stringify(`start ${KEY} end`)}) process.stdout.write(c);`;
      const result = await run(script);
      expect(result.stdout).toBe(`start ${REDACTED} end`);
      expect(result.stdout).not.toContain("zkp8CZ");
    });

    /**
     * The one leak the corpus proves is real: Leo prints the first 24 characters
     * of the signing key in its deployment plan summary. It is 12 characters of
     * key material past the marker — far short of the certainty threshold — so
     * only the `...` rule catches it, and without that it would be forwarded to
     * the user verbatim.
     */
    it("redacts Leo's truncated key from its plan summary", async () => {
      const line = "  Private Key:        APrivateKey1zkp8CZNn3yeC...\n";
      const result = await run(`process.stdout.write(${JSON.stringify(line)});`);
      expect(result.stdout).toBe(`  Private Key:        ${REDACTED}\n`);
      expect(result.stdout).not.toContain("zkp8CZ");
    });

    /**
     * The same thing through a verbatim capture of the real 4.3.2 CLI, so the
     * assertion is against Leo's actual output rather than a transcription of
     * it. This capture is 1.1 KiB — comfortably inside the 4 KiB tail — so the
     * line reaching the assertion is not a coincidence.
     */
    it("redacts it in a real captured Leo run, forwarded through the runner", async () => {
      const capture = loadLeoCliCapture("deploy-skip-all");
      expect(capture.stdout).toContain("APrivateKey1zkp8CZNn3yeC...");

      const result = await run(`process.stdout.write(${JSON.stringify(capture.stdout)});`);
      expect(result.stdout).toContain(`Private Key:        ${REDACTED}`);
      expect(result.stdout).not.toContain("APrivateKey1");
      expect(result.stdout).not.toContain("zkp8CZ");
      // Everything else Leo said still gets through.
      expect(result.stdout).toContain("Skipped Programs");
    });

    it("redacts a caller-supplied secret", async () => {
      const result = await run('process.stdout.write("auth s3cret-token-value done");', {
        secrets: ["s3cret-token-value"],
      });
      expect(result.stdout).toBe(`auth ${REDACTED} done`);
    });

    /**
     * The tail is bounded, and redaction happens on the way in, so a secret can
     * never survive by straddling the eviction boundary.
     */
    it("keeps the tail bounded and still redacted under heavy output", async () => {
      const script =
        `process.stdout.write("${KEY}");` +
        'for (let i = 0; i < 2000; i++) process.stdout.write("filler-line-" + i + "\\n");' +
        `process.stdout.write("${KEY}");`;
      const result = await run(script);
      expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024);
      expect(result.stdout).not.toContain("APrivateKey1");
      expect(result.stdout).not.toContain("zkp8CZ");
    });
  });

  describe("timeout", () => {
    it("does not fire when the process finishes in time", async () => {
      const result = await run("process.exit(0);", { timeoutMs: 30_000 });
      expect(result.timedOut).toBe(false);
    });

    it("terminates a hung process and flags the timeout", async () => {
      const result = await run("setInterval(() => {}, 1000);", { timeoutMs: 150 });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    });

    /**
     * SIGTERM first, SIGKILL after a grace period — so a child that installs a
     * SIGTERM handler and refuses to die still cannot hang the deploy. The
     * escalation is 5s, so this asserts the signal rather than waiting it out.
     */
    it("escalates past a process that ignores SIGTERM", async () => {
      const result = await run('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);', {
        timeoutMs: 150,
      });
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
    }, 20_000);

    it("never times out when the timeout is disabled", async () => {
      const result = await run("setTimeout(() => process.exit(0), 200);", { timeoutMs: 0 });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    });
  });

  it("rejects when the binary cannot be spawned", async () => {
    await expect(
      spawnLeoRunner({
        binary: "/definitely/not/a/binary/leo",
        argv: [],
        env: {},
        cwd: process.cwd(),
        timeoutMs: 0,
        logMode: "quiet-buffered",
        secrets: [],
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});
