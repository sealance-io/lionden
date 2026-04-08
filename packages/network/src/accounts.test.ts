import { describe, it, expect } from "vitest";
import { DEVNODE_ACCOUNTS, getDefaultAccount } from "./accounts.js";

describe("DEVNODE_ACCOUNTS", () => {
  it("provides 4 well-known accounts", () => {
    expect(DEVNODE_ACCOUNTS).toHaveLength(4);
  });

  it("each account has required fields", () => {
    for (const account of DEVNODE_ACCOUNTS) {
      expect(account.name).toBeTruthy();
      expect(account.privateKey).toMatch(/^APrivateKey1/);
      expect(account.address).toMatch(/^aleo1/);
      expect(account.initialBalance).toBeGreaterThan(0n);
    }
  });

  it("accounts have unique names, keys, and addresses", () => {
    const names = DEVNODE_ACCOUNTS.map((a) => a.name);
    const keys = DEVNODE_ACCOUNTS.map((a) => a.privateKey);
    const addrs = DEVNODE_ACCOUNTS.map((a) => a.address);

    expect(new Set(names).size).toBe(4);
    expect(new Set(keys).size).toBe(4);
    expect(new Set(addrs).size).toBe(4);
  });

  it("accounts have ~23.4T microcredits initial balance", () => {
    for (const account of DEVNODE_ACCOUNTS) {
      expect(account.initialBalance).toBe(23_437_500_000_000n);
    }
  });
});

describe("getDefaultAccount", () => {
  it("returns account-0", () => {
    const account = getDefaultAccount();
    expect(account.name).toBe("account-0");
    expect(account).toBe(DEVNODE_ACCOUNTS[0]);
  });
});
