/**
 * Unit tests for NamedAccountManager.
 *
 * These tests use vi.mock to avoid loading the real Provable SDK (WASM).
 * The address derivation path is mocked; all other logic is tested at full fidelity.
 */

import type { ResolvedNamedAccountsConfig } from "@lionden/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNODE_ACCOUNTS } from "./accounts.js";
import { NamedAccountManager } from "./named-account-manager.js";

// Mock the dynamic sdk-adapter import used for address derivation
vi.mock("./sdk-adapter.js", () => ({
  createSdkObjects: vi.fn(),
}));

import { createSdkObjects } from "./sdk-adapter.js";

const mockCreateSdkObjects = vi.mocked(createSdkObjects);

const DEVNODE_ADDR_0 = DEVNODE_ACCOUNTS[0]!.address;
const DEVNODE_KEY_0 = DEVNODE_ACCOUNTS[0]!.privateKey;
const DEVNODE_ADDR_1 = DEVNODE_ACCOUNTS[1]!.address;
const DEVNODE_KEY_1 = DEVNODE_ACCOUNTS[1]!.privateKey;
const TREASURY_ADDR = "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5";
const DERIVED_ADDR = "aleo1derivedxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const PRIVATE_KEY = "APrivateKey1zkpFakeKey123456789012345678901234567890";

function makeOpts(networkName = "devnode", networkType: "devnode" | "http" = "devnode") {
  return {
    networkName,
    networkType,
    networkId: "testnet" as const,
    endpoint: "http://127.0.0.1:3030",
    egressPolicy: {
      allowedNetworkHosts: new Set(["127.0.0.1:3030"]),
      violation: "block" as const,
    },
  };
}

describe("NamedAccountManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSdkObjects.mockResolvedValue({
      account: {
        address: () => ({ to_string: () => DERIVED_ADDR }),
      },
    } as any);
  });

  // ---------------------------------------------------------------------------
  // Empty config
  // ---------------------------------------------------------------------------

  it("returns empty record when no namedAccounts configured", async () => {
    const manager = new NamedAccountManager({});
    const result = await manager.resolveForNetwork(makeOpts());
    expect(result).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Index resolution
  // ---------------------------------------------------------------------------

  it("resolves index 0 on devnode to DEVNODE_ACCOUNTS[0] as SignableNamedAccount", async () => {
    const config: ResolvedNamedAccountsConfig = {
      deployer: { networks: {}, default: { type: "index", index: 0 } },
    };
    const manager = new NamedAccountManager(config);
    const result = await manager.resolveForNetwork(makeOpts("devnode", "devnode"));
    expect(result["deployer"]).toEqual({
      type: "signable",
      name: "deployer",
      address: DEVNODE_ADDR_0,
      privateKey: DEVNODE_KEY_0,
    });
  });

  it("resolves index 1 on devnode to DEVNODE_ACCOUNTS[1]", async () => {
    const config: ResolvedNamedAccountsConfig = {
      admin: { networks: {}, default: { type: "index", index: 1 } },
    };
    const manager = new NamedAccountManager(config);
    const result = await manager.resolveForNetwork(makeOpts("devnode", "devnode"));
    expect(result["admin"]!.address).toBe(DEVNODE_ADDR_1);
    expect((result["admin"] as any).privateKey).toBe(DEVNODE_KEY_1);
  });

  it("throws for index on HTTP network", async () => {
    const config: ResolvedNamedAccountsConfig = {
      deployer: { networks: {}, default: { type: "index", index: 0 } },
    };
    const manager = new NamedAccountManager(config);
    await expect(manager.resolveForNetwork(makeOpts("testnet", "http"))).rejects.toThrow(
      /devnode account index 0.*HTTP/i,
    );
  });

  it("throws for out-of-range index", async () => {
    const config: ResolvedNamedAccountsConfig = {
      deployer: { networks: {}, default: { type: "index", index: 999 } },
    };
    const manager = new NamedAccountManager(config);
    await expect(manager.resolveForNetwork(makeOpts("devnode", "devnode"))).rejects.toThrow(
      /index 999/,
    );
  });

  // ---------------------------------------------------------------------------
  // Address resolution
  // ---------------------------------------------------------------------------

  it("resolves address string to AddressOnlyNamedAccount", async () => {
    const config: ResolvedNamedAccountsConfig = {
      treasury: { networks: {}, default: { type: "address", address: TREASURY_ADDR } },
    };
    const manager = new NamedAccountManager(config);
    const result = await manager.resolveForNetwork(makeOpts());
    expect(result["treasury"]).toEqual({
      type: "address-only",
      name: "treasury",
      address: TREASURY_ADDR,
    });
  });

  // ---------------------------------------------------------------------------
  // Private key resolution
  // ---------------------------------------------------------------------------

  it("resolves privateKey to SignableNamedAccount with derived address", async () => {
    const config: ResolvedNamedAccountsConfig = {
      deployer: { networks: {}, default: { type: "privateKey", privateKey: PRIVATE_KEY } },
    };
    const manager = new NamedAccountManager(config);
    const result = await manager.resolveForNetwork(makeOpts("testnet", "http"));
    expect(result["deployer"]).toEqual({
      type: "signable",
      name: "deployer",
      address: DERIVED_ADDR,
      privateKey: PRIVATE_KEY,
    });
    expect(mockCreateSdkObjects).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: PRIVATE_KEY }),
    );
  });

  // ---------------------------------------------------------------------------
  // Network-specific override vs default
  // ---------------------------------------------------------------------------

  it("prefers network-specific override over default", async () => {
    const testnetKey = "APrivateKey1zkpTestnet";
    const config: ResolvedNamedAccountsConfig = {
      deployer: {
        networks: { testnet: { type: "privateKey", privateKey: testnetKey } },
        default: { type: "index", index: 0 },
      },
    };
    const manager = new NamedAccountManager(config);

    // On devnode: uses default (index 0)
    const devResult = await manager.resolveForNetwork(makeOpts("devnode", "devnode"));
    expect(devResult["deployer"]!.type).toBe("signable");
    expect((devResult["deployer"] as any).address).toBe(DEVNODE_ADDR_0);

    // On testnet: uses override (private key)
    const testnetResult = await manager.resolveForNetwork(makeOpts("testnet", "http"));
    expect(testnetResult["deployer"]!.type).toBe("signable");
    expect((testnetResult["deployer"] as any).privateKey).toBe(testnetKey);
  });

  it("throws when no default and no network override", async () => {
    const config: ResolvedNamedAccountsConfig = {
      deployer: {
        networks: { testnet: { type: "index", index: 0 } },
        default: undefined,
      },
    };
    const manager = new NamedAccountManager(config);
    await expect(manager.resolveForNetwork(makeOpts("devnode", "devnode"))).rejects.toThrow(
      /no value for network "devnode" and no default/,
    );
  });

  // ---------------------------------------------------------------------------
  // Caching
  // ---------------------------------------------------------------------------

  it("returns cached result on repeated calls for the same network", async () => {
    const config: ResolvedNamedAccountsConfig = {
      deployer: { networks: {}, default: { type: "index", index: 0 } },
    };
    const manager = new NamedAccountManager(config);

    const first = await manager.resolveForNetwork(makeOpts());
    const second = await manager.resolveForNetwork(makeOpts());
    expect(first).toBe(second); // same object reference (from cache)
  });

  it("invalidate() clears all cached results", async () => {
    const config: ResolvedNamedAccountsConfig = {
      deployer: { networks: {}, default: { type: "index", index: 0 } },
    };
    const manager = new NamedAccountManager(config);
    const first = await manager.resolveForNetwork(makeOpts());
    manager.invalidate();
    const second = await manager.resolveForNetwork(makeOpts());
    // After invalidation, a new object is created (different reference)
    expect(first).not.toBe(second);
    // But same content
    expect(second["deployer"]!.address).toBe(DEVNODE_ADDR_0);
  });

  // ---------------------------------------------------------------------------
  // Defensive copy
  // ---------------------------------------------------------------------------

  it("mutating the returned object does not affect the cache", async () => {
    const config: ResolvedNamedAccountsConfig = {
      treasury: { networks: {}, default: { type: "address", address: TREASURY_ADDR } },
    };
    const manager = new NamedAccountManager(config);
    const result = (await manager.resolveForNetwork(makeOpts())) as Record<
      string,
      { address: string }
    >;
    // resolveForNetwork deeply freezes the result, so callers cannot reach the cache —
    // neither the top-level map nor the account objects inside it are mutable.
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result["treasury"])).toBe(true);
    // In ESM strict mode, writing through either level throws — the mutation never lands.
    expect(() => {
      result["treasury"] = { address: "aleo1tampered" };
    }).toThrow();
    expect(() => {
      result["treasury"]!.address = "aleo1tampered";
    }).toThrow();
    // The cache is unaffected: the next call still returns the original value.
    const cached = await manager.resolveForNetwork(makeOpts());
    expect(cached["treasury"]!.address).toBe(TREASURY_ADDR);
  });
});
