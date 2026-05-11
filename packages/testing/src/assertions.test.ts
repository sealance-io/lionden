import { describe, it, expect, vi } from "vitest";
import { createMockConnection } from "@lionden/test-internals";
import {
  assertMappingValue,
  assertMappingEmpty,
  assertTransactionConfirmed,
  assertTransactionRejected,
  assertBalanceAtLeast,
  assertBalance,
  assertBlockHeightAtLeast,
  AssertionError,
} from "./assertions.js";

const mockConnection = createMockConnection;

describe("assertions", () => {
  describe("assertMappingValue", () => {
    it("passes when value matches", async () => {
      const conn = mockConnection({
        getMappingValue: vi.fn().mockResolvedValue("100u64"),
      });

      await expect(
        assertMappingValue(conn, "token.aleo", "balances", "aleo1abc", "100u64"),
      ).resolves.toBeUndefined();
    });

    it("throws when key has no entry", async () => {
      const conn = mockConnection({
        getMappingValue: vi.fn().mockResolvedValue(null),
      });

      await expect(
        assertMappingValue(conn, "token.aleo", "balances", "aleo1abc", "100u64"),
      ).rejects.toThrow(AssertionError);
    });

    it("throws when value does not match", async () => {
      const conn = mockConnection({
        getMappingValue: vi.fn().mockResolvedValue("200u64"),
      });

      await expect(
        assertMappingValue(conn, "token.aleo", "balances", "aleo1abc", "100u64"),
      ).rejects.toThrow("200u64");
    });

    it("normalizes whitespace for comparison", async () => {
      const conn = mockConnection({
        getMappingValue: vi.fn().mockResolvedValue("  100u64  "),
      });

      await expect(
        assertMappingValue(conn, "token.aleo", "balances", "aleo1abc", "100u64"),
      ).resolves.toBeUndefined();
    });
  });

  describe("assertMappingEmpty", () => {
    it("passes when key has no entry", async () => {
      const conn = mockConnection({
        getMappingValue: vi.fn().mockResolvedValue(null),
      });

      await expect(
        assertMappingEmpty(conn, "token.aleo", "balances", "aleo1abc"),
      ).resolves.toBeUndefined();
    });

    it("throws when key has an entry", async () => {
      const conn = mockConnection({
        getMappingValue: vi.fn().mockResolvedValue("100u64"),
      });

      await expect(
        assertMappingEmpty(conn, "token.aleo", "balances", "aleo1abc"),
      ).rejects.toThrow(AssertionError);
    });
  });

  describe("assertTransactionConfirmed", () => {
    it("passes when transaction is accepted", async () => {
      const conn = mockConnection({
        waitForConfirmation: vi.fn().mockResolvedValue({
          txId: "at1test", blockHeight: 10, status: "accepted", transitions: [],
        }),
      });

      await expect(
        assertTransactionConfirmed(conn, "at1test"),
      ).resolves.toBeUndefined();
    });

    it("throws when transaction is rejected", async () => {
      const conn = mockConnection({
        waitForConfirmation: vi.fn().mockResolvedValue({
          txId: "at1test", blockHeight: 10, status: "rejected", transitions: [],
        }),
      });

      await expect(
        assertTransactionConfirmed(conn, "at1test"),
      ).rejects.toThrow("rejected");
    });
  });

  describe("assertTransactionRejected", () => {
    it("passes when transaction is rejected", async () => {
      const conn = mockConnection({
        waitForConfirmation: vi.fn().mockResolvedValue({
          txId: "at1test", blockHeight: 10, status: "rejected", transitions: [],
        }),
      });

      await expect(
        assertTransactionRejected(conn, "at1test"),
      ).resolves.toBeUndefined();
    });

    it("throws when transaction is accepted", async () => {
      const conn = mockConnection({
        waitForConfirmation: vi.fn().mockResolvedValue({
          txId: "at1test", blockHeight: 10, status: "accepted", transitions: [],
        }),
      });

      await expect(
        assertTransactionRejected(conn, "at1test"),
      ).rejects.toThrow("accepted");
    });
  });

  describe("assertBalanceAtLeast", () => {
    it("passes when balance is above minimum", async () => {
      const conn = mockConnection({
        getBalance: vi.fn().mockResolvedValue(1000n),
      });

      await expect(
        assertBalanceAtLeast(conn, "aleo1abc", 500n),
      ).resolves.toBeUndefined();
    });

    it("passes when balance equals minimum", async () => {
      const conn = mockConnection({
        getBalance: vi.fn().mockResolvedValue(1000n),
      });

      await expect(
        assertBalanceAtLeast(conn, "aleo1abc", 1000n),
      ).resolves.toBeUndefined();
    });

    it("throws when balance is below minimum", async () => {
      const conn = mockConnection({
        getBalance: vi.fn().mockResolvedValue(100n),
      });

      await expect(
        assertBalanceAtLeast(conn, "aleo1abc", 500n),
      ).rejects.toThrow(AssertionError);
    });
  });

  describe("assertBalance", () => {
    it("passes when balance matches exactly", async () => {
      const conn = mockConnection({
        getBalance: vi.fn().mockResolvedValue(1000n),
      });

      await expect(
        assertBalance(conn, "aleo1abc", 1000n),
      ).resolves.toBeUndefined();
    });

    it("throws when balance does not match", async () => {
      const conn = mockConnection({
        getBalance: vi.fn().mockResolvedValue(999n),
      });

      await expect(
        assertBalance(conn, "aleo1abc", 1000n),
      ).rejects.toThrow(AssertionError);
    });
  });

  describe("assertBlockHeightAtLeast", () => {
    it("passes when height meets minimum", async () => {
      const conn = mockConnection({
        getBlockHeight: vi.fn().mockResolvedValue(100),
      });

      await expect(
        assertBlockHeightAtLeast(conn, 50),
      ).resolves.toBeUndefined();
    });

    it("throws when height is below minimum", async () => {
      const conn = mockConnection({
        getBlockHeight: vi.fn().mockResolvedValue(10),
      });

      await expect(
        assertBlockHeightAtLeast(conn, 50),
      ).rejects.toThrow(AssertionError);
    });
  });
});
