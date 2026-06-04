import { describe, expect, it } from "vitest";
import {
  DEVNODE_ACCOUNTS,
  getAccount,
  getAccountByAddress,
  getAddresses,
  getDefaultAccount,
} from "./accounts.js";

describe("accounts", () => {
  describe("DEVNODE_ACCOUNTS", () => {
    it("provides exactly 4 accounts", () => {
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

    it("all accounts have unique addresses", () => {
      const addresses = DEVNODE_ACCOUNTS.map((a) => a.address);
      expect(new Set(addresses).size).toBe(4);
    });

    it("all accounts have unique private keys", () => {
      const keys = DEVNODE_ACCOUNTS.map((a) => a.privateKey);
      expect(new Set(keys).size).toBe(4);
    });
  });

  describe("getDefaultAccount", () => {
    it("returns account-0", () => {
      const account = getDefaultAccount();
      expect(account.name).toBe("account-0");
      expect(account).toBe(DEVNODE_ACCOUNTS[0]);
    });
  });

  describe("getAccount", () => {
    it("returns account by index", () => {
      expect(getAccount(0).name).toBe("account-0");
      expect(getAccount(1).name).toBe("account-1");
      expect(getAccount(2).name).toBe("account-2");
      expect(getAccount(3).name).toBe("account-3");
    });

    it("throws for negative index", () => {
      expect(() => getAccount(-1)).toThrow(RangeError);
      expect(() => getAccount(-1)).toThrow("out of range");
    });

    it("throws for index >= 4", () => {
      expect(() => getAccount(4)).toThrow(RangeError);
      expect(() => getAccount(100)).toThrow(RangeError);
    });
  });

  describe("getAddresses", () => {
    it("returns all 4 addresses", () => {
      const addresses = getAddresses();
      expect(addresses).toHaveLength(4);
      for (const addr of addresses) {
        expect(addr).toMatch(/^aleo1/);
      }
    });
  });

  describe("getAccountByAddress", () => {
    it("returns account matching address", () => {
      const account = getAccountByAddress(DEVNODE_ACCOUNTS[2]!.address);
      expect(account).toBe(DEVNODE_ACCOUNTS[2]);
    });

    it("returns undefined for unknown address", () => {
      expect(getAccountByAddress("aleo1unknown")).toBeUndefined();
    });
  });
});
