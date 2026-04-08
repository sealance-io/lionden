/**
 * DevnetManager — manages a multi-validator `leo devnet` process.
 *
 * A devnet runs multiple snarkOS validators and clients locally,
 * providing a more realistic network environment than a single devnode.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AleoNetwork } from "@lionden/config";

export interface DevnetStartOptions {
  /** Number of validators. Default: 4 */
  numValidators?: number;
  /** Number of clients. Default: 2 */
  numClients?: number;
  /** Network type. Default: "testnet" */
  network?: AleoNetwork;
  /** Path to snarkOS binary. Default: "snarkos" */
  snarkosPath?: string;
  /** Verbosity (0-4). Default: 1 */
  verbosity?: number;
  /** Base REST port. Default: 3030 */
  restPort?: number;
  /** Storage directory. */
  storageDir?: string;
}

const HEALTH_CHECK_INTERVAL_MS = 1_000;
const HEALTH_CHECK_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export class DevnetManager {
  private processes: ChildProcess[] = [];
  private _endpoint = "";

  /** REST API endpoint URL for the first validator. */
  get endpoint(): string {
    return this._endpoint;
  }

  /** Whether the devnet processes are running. */
  isRunning(): boolean {
    return this.processes.length > 0 && this.processes.some((p) => p.exitCode === null);
  }

  /**
   * Start a local devnet.
   * Spawns snarkOS validators and clients, then waits for the REST API.
   */
  async start(options: DevnetStartOptions = {}): Promise<void> {
    if (this.isRunning()) {
      throw new Error("Devnet is already running. Call stop() first.");
    }

    const restPort = options.restPort ?? 3030;
    const network = options.network ?? "testnet";
    this._endpoint = `http://127.0.0.1:${restPort}`;

    const args = this.buildArgs(options);

    const proc = spawn("leo", ["devnet", "start", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processes.push(proc);

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const earlyExit = new Promise<never>((_, reject) => {
      proc.on("error", (err) => {
        reject(
          new Error(
            `Failed to start devnet: ${err.message}. ` +
              `Ensure Leo CLI v4.0.0 and snarkOS are installed.`,
          ),
        );
      });
      proc.on("exit", (code) => {
        if (code !== null && code !== 0) {
          reject(
            new Error(
              `Devnet exited with code ${code}.\n${stderr.slice(0, 500)}`,
            ),
          );
        }
      });
    });

    const healthCheck = this.waitForHealthy(network, restPort);

    try {
      await Promise.race([healthCheck, earlyExit]);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** Stop all devnet processes. */
  async stop(): Promise<void> {
    const procs = [...this.processes];
    this.processes = [];

    await Promise.all(
      procs.map(
        (proc) =>
          new Promise<void>((resolve) => {
            if (proc.exitCode !== null) {
              resolve();
              return;
            }
            const killTimer = setTimeout(() => {
              proc.kill("SIGKILL");
            }, SHUTDOWN_TIMEOUT_MS);

            proc.on("exit", () => {
              clearTimeout(killTimer);
              resolve();
            });

            proc.kill("SIGTERM");
          }),
      ),
    );
  }

  private buildArgs(options: DevnetStartOptions): string[] {
    const args: string[] = [];

    if (options.numValidators !== undefined) {
      args.push("--num-validators", String(options.numValidators));
    }
    if (options.numClients !== undefined) {
      args.push("--num-clients", String(options.numClients));
    }
    if (options.network && options.network !== "testnet") {
      args.push("--network", options.network);
    }
    if (options.verbosity !== undefined && options.verbosity > 0) {
      args.push("-" + "v".repeat(Math.min(options.verbosity, 4)));
    }
    if (options.restPort !== undefined && options.restPort !== 3030) {
      args.push("--rest-port", String(options.restPort));
    }
    if (options.storageDir) {
      args.push("--storage-dir", options.storageDir);
    }

    return args;
  }

  private async waitForHealthy(
    network: string,
    port: number,
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}/${network}/block/height/latest`;
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

    throw new Error(
      `Devnet health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms. ` +
        `Expected REST API at ${url}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
