/**
 * DevnodeManager — manages the lifecycle of a `leo devnode start` process.
 *
 * Handles spawning, health-checking, and graceful shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { DevnodeStartOptions } from "./types.js";

const DEFAULT_SOCKET_ADDR = "127.0.0.1:3030";
const DEFAULT_PRIVATE_KEY =
  "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";
const HEALTH_CHECK_INTERVAL_MS = 200;
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export class DevnodeManager {
  private process: ChildProcess | null = null;
  private _endpoint = "";

  /** REST API endpoint URL (e.g., "http://127.0.0.1:3030") */
  get endpoint(): string {
    return this._endpoint;
  }

  /** Whether the devnode process is currently running. */
  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * Start a devnode process with the given options.
   * Waits for the REST API to become healthy before returning.
   */
  async start(options: DevnodeStartOptions = {}): Promise<void> {
    if (this.isRunning()) {
      throw new Error("Devnode is already running. Call stop() first.");
    }

    const socketAddr = options.socketAddr ?? DEFAULT_SOCKET_ADDR;
    this._endpoint = `http://${socketAddr}`;

    const args = this.buildArgs(options);
    const network = options.network ?? "testnet";

    const leoBinary = options.leoBinary ?? "leo";

    this.process = spawn(leoBinary, ["--disable-update-check", "devnode", "start", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture stderr for error reporting
    let stderr = "";
    this.process.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Handle early exit (e.g., port in use, leo not found)
    const earlyExit = new Promise<never>((_, reject) => {
      this.process!.on("error", (err) => {
        reject(
          new Error(
            `Failed to start devnode: ${err.message}. ` +
              `Ensure the Leo CLI ("${leoBinary}") is installed and accessible.`,
          ),
        );
      });
      this.process!.on("exit", (code) => {
        if (code !== null && code !== 0) {
          reject(
            new Error(
              `Devnode exited with code ${code}.\n${stderr.slice(0, 500)}`,
            ),
          );
        }
      });
    });

    // Wait for REST API to respond
    const healthCheck = this.waitForHealthy(network);

    try {
      await Promise.race([healthCheck, earlyExit]);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /**
   * Stop the devnode process gracefully.
   * Sends SIGTERM, then SIGKILL after timeout.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;

    if (proc.exitCode !== null) return;

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, SHUTDOWN_TIMEOUT_MS);

      proc.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      proc.kill("SIGTERM");
    });
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

    throw new Error(
      `Devnode health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms. ` +
        `Expected REST API at ${url}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
