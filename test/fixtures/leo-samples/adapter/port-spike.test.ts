/**
 * Phase 0e — port-override spike (deliverable: a confirmed note, not a harness).
 *
 * Confirms `networks.devnode.socketAddr` is honored end-to-end: a devnode booted
 * on a non-default port exposes its REST API there and answers a block-height
 * query. This is the single fact future per-suite-on-its-own-port parallelism
 * would rely on; building that harness is out of scope (see README § Port spike).
 *
 * Skips when no `leo` backend is on PATH. Runs in the leo-samples lane config
 * (serialized, never the unit lane), and binds a fixed TCP port — never run it
 * alongside another devnode-backed suite.
 */
import { execFileSync } from "node:child_process";
import { DevnodeManager } from "@lionden/network";
import { afterAll, describe, expect, it } from "vitest";

const SPIKE_PORT = "127.0.0.1:3031";

function leoAvailable(): boolean {
  try {
    execFileSync("leo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const manager = new DevnodeManager();

afterAll(async () => {
  if (manager.isRunning()) await manager.stop();
});

describe.skipIf(!leoAvailable())("0e port-override spike", () => {
  it("boots a devnode on a non-default socketAddr and serves block height there", async () => {
    await manager.start({ socketAddr: SPIKE_PORT, network: "testnet", logMode: "quiet-buffered" });

    // The override is reflected in the endpoint…
    expect(manager.endpoint).toBe(`http://${SPIKE_PORT}`);

    // …and the REST API actually answers there (start() already waited for it).
    const res = await fetch(`${manager.endpoint}/testnet/block/height/latest`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.ok).toBe(true);
    const height = Number(JSON.parse(await res.text()));
    expect(Number.isFinite(height)).toBe(true);
    expect(height).toBeGreaterThanOrEqual(0);
  });
});
