import { afterEach, describe, expect, it } from "vitest";
import { buildLeoEnv } from "./env.js";

const originalPrivateKey = process.env["PRIVATE_KEY"];
const originalDevnet = process.env["DEVNET"];

afterEach(() => {
  restore("PRIVATE_KEY", originalPrivateKey);
  restore("DEVNET", originalDevnet);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("buildLeoEnv", () => {
  it("carries the network and endpoint", () => {
    const env = buildLeoEnv({
      networkId: "testnet",
      endpoint: "http://127.0.0.1:3030",
      connectionType: "devnode",
    });
    expect(env["NETWORK"]).toBe("testnet");
    expect(env["ENDPOINT"]).toBe("http://127.0.0.1:3030");
  });

  it("inherits the ambient environment", () => {
    process.env["LIONDEN_ENV_PROBE"] = "kept";
    try {
      const env = buildLeoEnv({
        networkId: "testnet",
        endpoint: "http://127.0.0.1:3030",
        connectionType: "devnode",
      });
      expect(env["LIONDEN_ENV_PROBE"]).toBe("kept");
    } finally {
      delete process.env["LIONDEN_ENV_PROBE"];
    }
  });

  describe("PRIVATE_KEY", () => {
    /**
     * The key travels here and never in argv, following `runRestoreCommand` in
     * `devnode-manager.ts`: argv is world-readable through the process list.
     */
    it("is set from the effective signing key", () => {
      const env = buildLeoEnv({
        networkId: "testnet",
        endpoint: "http://127.0.0.1:3030",
        connectionType: "devnode",
        privateKey: "APrivateKey1zkpTEST",
      });
      expect(env["PRIVATE_KEY"]).toBe("APrivateKey1zkpTEST");
    });

    /**
     * An inherited key would silently sign with an identity lionden did not
     * choose — worse than failing, because the deployment would succeed under
     * the wrong account.
     *
     * Removing it is necessary but not sufficient: Leo then falls back to a
     * `.env` on disk. That remaining hole is closed a level up, in
     * `assertSigningKeyPresent`, which refuses to spawn Leo without a key — so
     * this branch is unreachable through the backend.
     */
    it("is removed, not inherited, when there is no key to use", () => {
      process.env["PRIVATE_KEY"] = "APrivateKey1zkpAMBIENT";
      const env = buildLeoEnv({
        networkId: "testnet",
        endpoint: "http://127.0.0.1:3030",
        connectionType: "devnode",
      });
      expect(env["PRIVATE_KEY"]).toBeUndefined();
    });
  });

  describe("DEVNET", () => {
    it("is the literal true on devnode", () => {
      const env = buildLeoEnv({
        networkId: "testnet",
        endpoint: "http://127.0.0.1:3030",
        connectionType: "devnode",
      });
      expect(env["DEVNET"]).toBe("true");
    });

    /**
     * The reason deleting the variable is not enough: Leo reads `DEVNET` from a
     * `.env` file in its working directory and every parent of it, and the
     * runner's cwd is the project root. A project whose `.env` carries
     * `DEVNET=true` from local devnode work would, on an unset shell variable,
     * send a real-network deployment out in devnet mode. `--devnet` is
     * valueless with no negative form, so an explicit `DEVNET=false` is the
     * only way to force it off.
     */
    it("is the literal false on http, overriding a DEVNET=true left on disk", () => {
      const env = buildLeoEnv({
        networkId: "testnet",
        endpoint: "https://api.explorer.provable.com/v1",
        connectionType: "http",
      });
      expect(env["DEVNET"]).toBe("false");
    });

    it("is never merely deleted", () => {
      for (const connectionType of ["devnode", "http"] as const) {
        process.env["DEVNET"] = "true";
        const env = buildLeoEnv({
          networkId: "testnet",
          endpoint: "http://x",
          connectionType,
        });
        expect(Object.hasOwn(env, "DEVNET"), connectionType).toBe(true);
        expect(env["DEVNET"], connectionType).toBe(connectionType === "devnode" ? "true" : "false");
      }
    });
  });
});
