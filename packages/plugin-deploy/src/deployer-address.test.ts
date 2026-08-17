/**
 * Deployer/admin signer-precedence contract.
 *
 * The no-`keyCache` guarantee is asserted where it lives — see
 * `packages/network/src/named-account-manager.test.ts`. Here the SDK boundary is
 * `deriveAddressFromPrivateKey` itself, so these tests stay about *which key*
 * gets derived and what happens when derivation fails.
 */

import type { ResolvedNetworkConfig } from "@lionden/config";
import { createMockConnection } from "@lionden/test-internals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDeployerAddress, tryDeriveAddress } from "./deployer-address.js";

const mockDerive = vi.hoisted(() => vi.fn());

vi.mock("@lionden/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lionden/network")>();
  return { ...original, deriveAddressFromPrivateKey: mockDerive };
});

const KEY_A = "APrivateKey1zkpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "APrivateKey1zkpBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const KEY_C = "APrivateKey1zkpCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function devnodeNetworkConfig(accounts: Array<{ privateKey: string }> = []): ResolvedNetworkConfig {
  return {
    type: "devnode",
    socketAddr: "127.0.0.1:3030",
    autoBlock: true,
    verbosity: 0,
    accounts,
    network: "testnet",
    ephemeral: true,
  } as ResolvedNetworkConfig;
}

/** The key `deriveAddressFromPrivateKey` was called with on the Nth call. */
function derivedKey(call = 0): string {
  return mockDerive.mock.calls[call]![0];
}

describe("deployer address derivation", () => {
  beforeEach(() => {
    mockDerive.mockReset();
    mockDerive.mockResolvedValue("aleo1derived");
  });

  it("derives over the connection's own network coordinates", async () => {
    const conn = createMockConnection();
    await expect(tryDeriveAddress(conn, KEY_A)).resolves.toBe("aleo1derived");

    expect(mockDerive).toHaveBeenCalledWith(
      KEY_A,
      conn.networkId,
      conn.endpoint,
      conn.apiKey,
      conn.egressPolicy,
    );
  });

  it("returns undefined rather than throwing when derivation fails", async () => {
    mockDerive.mockRejectedValue(new Error("wasm exploded"));
    await expect(tryDeriveAddress(createMockConnection(), KEY_A)).resolves.toBeUndefined();
  });

  it("prefers the signer override over both fallbacks", async () => {
    const conn = createMockConnection({ privateKey: KEY_A });
    await resolveDeployerAddress(conn, devnodeNetworkConfig([{ privateKey: KEY_C }]), KEY_B);
    expect(derivedKey()).toBe(KEY_B);
  });

  it("falls back to the connection key before the devnode account", async () => {
    const conn = createMockConnection({ privateKey: KEY_A });
    await resolveDeployerAddress(conn, devnodeNetworkConfig([{ privateKey: KEY_C }]));
    expect(derivedKey()).toBe(KEY_A);
  });

  it("falls back to the first devnode account last", async () => {
    await resolveDeployerAddress(
      createMockConnection(),
      devnodeNetworkConfig([{ privateKey: KEY_C }]),
    );
    expect(derivedKey()).toBe(KEY_C);
  });

  it("returns undefined without deriving when no key is available", async () => {
    const address = await resolveDeployerAddress(createMockConnection(), devnodeNetworkConfig());
    expect(address).toBeUndefined();
    expect(mockDerive).not.toHaveBeenCalled();
  });
});
