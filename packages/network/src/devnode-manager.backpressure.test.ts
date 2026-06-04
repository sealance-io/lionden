import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { setupChildLogging, stdioConfigForMode } from "./devnode-manager.js";

/**
 * Deterministic backpressure regression for the DevnodeManager stdio policy.
 *
 * The original bug was a child-process stdout pipe with no JS-side drain
 * listener: once the OS pipe buffer (~64 KiB) filled, the child blocked on
 * `write()` and the whole process wedged. This test proves the property at
 * the OS level by exercising the SAME helpers (`stdioConfigForMode` and
 * `setupChildLogging`) that `DevnodeManager.start()` uses, against a real
 * `node` child that floods stdout past pipe capacity.
 */

// Floods stdout with 256 chunks of 8 KiB = 2 MiB, well past the OS pipe buffer.
// Uses backpressure-aware `process.stdout.write(...)` + `'drain'` so the child
// itself never busy-loops past `write` returning false.
const FLOOD_SCRIPT = `
let n = 0;
const w = () => {
  if (!process.stdout.write(Buffer.alloc(8192))) {
    process.stdout.once("drain", w);
  } else {
    n++;
    if (n < 256) setImmediate(w);
    else process.exit(0);
  }
};
w();
`;

function trackChild(proc: ChildProcess): { exitP: Promise<void>; exited: () => boolean } {
  let didExit = false;
  const exitP = new Promise<void>((resolve) => {
    proc.once("exit", () => {
      didExit = true;
      resolve();
    });
  });
  return { exitP, exited: () => didExit };
}

describe("DevnodeManager stdio backpressure", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.shift()!;
      await c();
    }
  });

  it("setupChildLogging drains stdout fast enough for a 2 MiB flood to complete", async () => {
    const proc = spawn("node", ["-e", FLOOD_SCRIPT], {
      stdio: stdioConfigForMode("quiet-buffered"),
    });
    const { exitP, exited } = trackChild(proc);
    cleanups.push(async () => {
      if (!exited()) proc.kill("SIGKILL");
      await exitP;
    });

    setupChildLogging(proc, "quiet-buffered");

    // Race against a generous 5 s budget. With the drain attached, the flood
    // completes in well under a second on any modern machine.
    const timeoutMs = 5_000;
    const winner = await Promise.race([
      exitP.then(() => "exit" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
    ]);

    expect(winner).toBe("exit");
    expect(proc.exitCode).toBe(0);
  });

  it("without setupChildLogging the same flood wedges on a full pipe", async () => {
    const proc = spawn("node", ["-e", FLOOD_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { exitP, exited } = trackChild(proc);
    cleanups.push(async () => {
      if (!exited()) proc.kill("SIGKILL");
      await exitP;
    });

    // Deliberately DO NOT attach a drain. Race a 1 s timer against exit; the
    // timer must win because the child blocks on the first write past the
    // pipe buffer.
    const winner = await Promise.race([
      exitP.then(() => "exit" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);

    expect(winner).toBe("timeout");
    expect(exited()).toBe(false);
  });
});
