import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRun = vi.fn();
const mockExecute = vi.fn();
const mockBuildDevnodeExec = vi.fn();
const mockSubmitTransaction = vi.fn();
const mockGetProgramMappingValue = vi.fn();
const mockGetLatestHeight = vi.fn();
const mockGetProgram = vi.fn();
const mockCreateSdkObjects = vi.fn();
const mockCheckDevnodeSdkSupport = vi.fn();
const mockInitConsensusHeights = vi.fn();

vi.mock("./sdk-adapter.js", () => ({
  createSdkObjects: mockCreateSdkObjects,
  checkDevnodeSdkSupport: mockCheckDevnodeSdkSupport,
  initConsensusHeights: mockInitConsensusHeights,
}));

import { AleoConnection } from "./connection.js";

function createDevnodeConnection(overrides?: Partial<ConstructorParameters<typeof AleoConnection>[0]>) {
  return new AleoConnection({
    type: "devnode",
    name: "devnode",
    endpoint: "http://127.0.0.1:3030",
    networkId: "testnet",
    privateKey: "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
    ...overrides,
  });
}

function createHttpConnection(overrides?: Partial<ConstructorParameters<typeof AleoConnection>[0]>) {
  return new AleoConnection({
    type: "http",
    name: "testnet",
    endpoint: "https://api.explorer.provable.com/v1",
    networkId: "testnet",
    privateKey: "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
    ...overrides,
  });
}

describe("AleoConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetProgram.mockResolvedValue("program hello.aleo { }");
    mockSubmitTransaction.mockResolvedValue("at1broadcast");
    mockGetProgramMappingValue.mockResolvedValue("100u64");
    mockGetLatestHeight.mockResolvedValue(42);
    mockBuildDevnodeExec.mockResolvedValue("mock-tx-bytes");
    mockExecute.mockResolvedValue("at1executed");

    mockCreateSdkObjects.mockResolvedValue({
      account: {
        address: () => ({ to_string: () => "aleo1derived" }),
      },
      networkClient: {
        getProgram: mockGetProgram,
        submitTransaction: mockSubmitTransaction,
        getProgramMappingValue: mockGetProgramMappingValue,
        getLatestHeight: mockGetLatestHeight,
      },
      programManager: {
        run: mockRun,
        execute: mockExecute,
        buildDevnodeExecutionTransaction: mockBuildDevnodeExec,
      },
      keyProvider: {},
      recordProvider: {},
    });
  });

  // -------------------------------------------------------------------------
  // execute() — local mode (existing test, preserved)
  // -------------------------------------------------------------------------

  it("returns outputs from ExecutionResponse.getOutputs() for local execution", async () => {
    mockRun.mockResolvedValue({
      getOutputs: () => ["8u32"],
    });

    const connection = createDevnodeConnection();

    const result = await connection.execute("hello.aleo", "main", ["3u32", "5u32"], {
      mode: "local",
    });

    expect(result.outputs).toEqual(["8u32"]);
    expect(mockCheckDevnodeSdkSupport).toHaveBeenCalledOnce();
    expect(mockInitConsensusHeights).toHaveBeenCalledOnce();
    expect(mockRun).toHaveBeenCalledWith(
      "program hello.aleo { }",
      "main",
      ["3u32", "5u32"],
      false,
    );
  });

  // -------------------------------------------------------------------------
  // execute() — onchain paths
  // -------------------------------------------------------------------------

  describe("execute() onchain", () => {
    it("uses devnode fast-path when type=devnode and prove is falsy", async () => {
      const connection = createDevnodeConnection();

      const result = await connection.execute("hello.aleo", "main", ["1u32"]);

      expect(mockBuildDevnodeExec).toHaveBeenCalledWith({
        programName: "hello.aleo",
        functionName: "main",
        inputs: ["1u32"],
        priorityFee: 0,
        privateFee: false,
      });
      expect(mockSubmitTransaction).toHaveBeenCalledWith("mock-tx-bytes");
      expect(result.txId).toBe("at1broadcast");
      expect(result.outputs).toEqual([]);
    });

    it("passes fee and privateFee options to devnode fast-path builder", async () => {
      const connection = createDevnodeConnection();

      await connection.execute("hello.aleo", "main", ["1u32"], {
        fee: 500,
        privateFee: true,
      });

      expect(mockBuildDevnodeExec).toHaveBeenCalledWith({
        programName: "hello.aleo",
        functionName: "main",
        inputs: ["1u32"],
        priorityFee: 500,
        privateFee: true,
      });
    });

    it("falls back to pm.execute when prove=true on devnode", async () => {
      const connection = createDevnodeConnection();

      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        prove: true,
      });

      expect(mockBuildDevnodeExec).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledWith({
        programName: "hello.aleo",
        functionName: "main",
        inputs: ["1u32"],
        priorityFee: 0,
        privateFee: false,
      });
      expect(result.txId).toBe("at1executed");
    });

    it("falls back to pm.execute when buildDevnodeExecutionTransaction is absent", async () => {
      mockCreateSdkObjects.mockResolvedValue({
        account: {},
        networkClient: {
          getProgram: mockGetProgram,
          submitTransaction: mockSubmitTransaction,
          getProgramMappingValue: mockGetProgramMappingValue,
          getLatestHeight: mockGetLatestHeight,
        },
        programManager: {
          run: mockRun,
          execute: mockExecute,
          // no buildDevnodeExecutionTransaction
        },
        keyProvider: {},
        recordProvider: {},
      });

      const connection = createDevnodeConnection();

      const result = await connection.execute("hello.aleo", "main", ["1u32"]);

      expect(mockExecute).toHaveBeenCalled();
      expect(result.txId).toBe("at1executed");
    });

    it("uses pm.execute for http connections", async () => {
      const connection = createHttpConnection();

      const result = await connection.execute("hello.aleo", "main", ["1u32"]);

      expect(mockCheckDevnodeSdkSupport).not.toHaveBeenCalled();
      expect(mockInitConsensusHeights).not.toHaveBeenCalled();
      expect(mockBuildDevnodeExec).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledWith({
        programName: "hello.aleo",
        functionName: "main",
        inputs: ["1u32"],
        priorityFee: 0,
        privateFee: false,
      });
      expect(result.txId).toBe("at1executed");
    });

    it("returns { outputs: [], txId } for onchain execution", async () => {
      const connection = createDevnodeConnection();

      const result = await connection.execute("hello.aleo", "main", ["1u32"]);

      expect(result.outputs).toEqual([]);
      expect(result.txId).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // getMappingValue()
  // -------------------------------------------------------------------------

  describe("getMappingValue()", () => {
    it("returns string value when key exists", async () => {
      mockGetProgramMappingValue.mockResolvedValue("100u64");
      const connection = createDevnodeConnection();

      const value = await connection.getMappingValue("token.aleo", "balances", "aleo1abc");

      expect(value).toBe("100u64");
      expect(mockGetProgramMappingValue).toHaveBeenCalledWith(
        "token.aleo",
        "balances",
        "aleo1abc",
      );
    });

    it("returns null when SDK returns undefined", async () => {
      mockGetProgramMappingValue.mockResolvedValue(undefined);
      const connection = createDevnodeConnection();

      const value = await connection.getMappingValue("token.aleo", "balances", "aleo1abc");

      expect(value).toBeNull();
    });

    it("returns null when SDK returns null", async () => {
      mockGetProgramMappingValue.mockResolvedValue(null);
      const connection = createDevnodeConnection();

      const value = await connection.getMappingValue("token.aleo", "balances", "aleo1abc");

      expect(value).toBeNull();
    });

    it("converts non-string values to string", async () => {
      mockGetProgramMappingValue.mockResolvedValue(42);
      const connection = createDevnodeConnection();

      const value = await connection.getMappingValue("token.aleo", "balances", "aleo1abc");

      expect(value).toBe("42");
    });

    it("returns null when SDK throws 404 error", async () => {
      mockGetProgramMappingValue.mockRejectedValue(new Error("HTTP 404: mapping not found"));
      const connection = createDevnodeConnection();

      const value = await connection.getMappingValue("token.aleo", "balances", "aleo1abc");

      expect(value).toBeNull();
    });

    it("returns null when SDK throws 'Not Found' error", async () => {
      mockGetProgramMappingValue.mockRejectedValue(new Error("Not Found"));
      const connection = createDevnodeConnection();

      const value = await connection.getMappingValue("token.aleo", "balances", "aleo1abc");

      expect(value).toBeNull();
    });

    it("returns null when SDK throws 'not found' (lowercase) error", async () => {
      mockGetProgramMappingValue.mockRejectedValue(new Error("key not found in mapping"));
      const connection = createDevnodeConnection();

      const value = await connection.getMappingValue("token.aleo", "balances", "aleo1abc");

      expect(value).toBeNull();
    });

    it("rethrows non-404 errors with context message", async () => {
      mockGetProgramMappingValue.mockRejectedValue(new Error("connection refused"));
      const connection = createDevnodeConnection();

      await expect(
        connection.getMappingValue("token.aleo", "balances", "aleo1abc"),
      ).rejects.toThrow("Failed to query mapping token.aleo/balances");
    });
  });

  // -------------------------------------------------------------------------
  // getBalance()
  // -------------------------------------------------------------------------

  describe("getBalance()", () => {
    it("returns 0n when mapping key has no entry", async () => {
      mockGetProgramMappingValue.mockRejectedValue(new Error("404 not found"));
      const connection = createDevnodeConnection();

      const balance = await connection.getBalance("aleo1abc");

      expect(balance).toBe(0n);
    });

    it("strips u64 suffix and returns BigInt", async () => {
      mockGetProgramMappingValue.mockResolvedValue("123456u64");
      const connection = createDevnodeConnection();

      const balance = await connection.getBalance("aleo1abc");

      expect(balance).toBe(123456n);
    });

    it("strips u128 suffix", async () => {
      mockGetProgramMappingValue.mockResolvedValue("999u128");
      const connection = createDevnodeConnection();

      const balance = await connection.getBalance("aleo1abc");

      expect(balance).toBe(999n);
    });

    it("queries credits.aleo/account with the given address", async () => {
      mockGetProgramMappingValue.mockResolvedValue("100u64");
      const connection = createDevnodeConnection();

      await connection.getBalance("aleo1specific");

      expect(mockGetProgramMappingValue).toHaveBeenCalledWith(
        "credits.aleo",
        "account",
        "aleo1specific",
      );
    });

    it("derives default address from private key when no address given", async () => {
      mockGetProgramMappingValue.mockResolvedValue("100u64");
      const connection = createDevnodeConnection();

      await connection.getBalance();

      expect(mockGetProgramMappingValue).toHaveBeenCalledWith(
        "credits.aleo",
        "account",
        "aleo1derived",
      );
    });

    it("throws when no address and no private key configured", async () => {
      const connection = createDevnodeConnection({ privateKey: undefined });

      await expect(connection.getBalance()).rejects.toThrow(
        "No address specified",
      );
    });
  });

  // -------------------------------------------------------------------------
  // waitForConfirmation()
  // -------------------------------------------------------------------------

  describe("waitForConfirmation()", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers();
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns confirmed transaction on first successful poll", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ block_height: 42 }),
      });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 42,
        status: "accepted",
      });
    });

    it("polls the correct URL with networkId and txId", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ block_height: 1 }),
      });
      const connection = createDevnodeConnection();

      await connection.waitForConfirmation("at1test");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3030/testnet/transaction/at1test",
        expect.objectContaining({ headers: {} }),
      );
    });

    it("includes Authorization header when apiKey is set", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ block_height: 1 }),
      });
      const connection = createDevnodeConnection({ apiKey: "mykey" });

      await connection.waitForConfirmation("at1test");

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: "Bearer mykey" },
        }),
      );
    });

    it("retries when fetch returns non-ok, succeeds on next poll", async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ block_height: 10 }),
        });
      const connection = createDevnodeConnection();

      const promise = connection.waitForConfirmation("at1test", 10_000);
      // Advance past the first poll interval to trigger retry
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("accepted");
    });

    it("retries when fetch throws (network error), succeeds on next poll", async () => {
      fetchMock
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ block_height: 5 }),
        });
      const connection = createDevnodeConnection();

      const promise = connection.waitForConfirmation("at1test", 10_000);
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.blockHeight).toBe(5);
    });

    it("throws after timeout expires", async () => {
      fetchMock.mockResolvedValue({ ok: false });
      const connection = createDevnodeConnection();

      const promise = connection.waitForConfirmation("at1test", 3_000);
      // Prevent unhandled rejection — the rejection fires during timer advancement
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(4_000);

      await expect(promise).rejects.toThrow("not confirmed within 3000ms");
    });

    it("uses default 60s timeout when none specified", async () => {
      fetchMock.mockResolvedValue({ ok: false });
      const connection = createDevnodeConnection();

      const promise = connection.waitForConfirmation("at1test");
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(61_000);

      await expect(promise).rejects.toThrow("not confirmed within 60000ms");
    });

    it("defaults blockHeight to 0 when missing from response JSON", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({}), // no block_height field
      });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result.blockHeight).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // advanceBlocks() — existing happy-path test + error path
  // -------------------------------------------------------------------------

  describe("advanceBlocks()", () => {
    it("uses the devnode block creation endpoint when advancing blocks", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });
      vi.stubGlobal("fetch", fetchMock);

      const connection = createDevnodeConnection();

      await connection.advanceBlocks?.(2);

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://127.0.0.1:3030/testnet/block/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ num_blocks: 1 }),
        },
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://127.0.0.1:3030/testnet/block/create",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ num_blocks: 1 }),
        },
      );
    });

    it("throws when fetch response is not ok", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });
      vi.stubGlobal("fetch", fetchMock);

      const connection = createDevnodeConnection();

      await expect(connection.advanceBlocks?.(1)).rejects.toThrow(
        "Failed to advance block: 500 Internal Server Error",
      );
    });

    it("is not defined for http connections", () => {
      const connection = createHttpConnection();

      expect(connection.advanceBlocks).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getBlockHeight()
  // -------------------------------------------------------------------------

  describe("getBlockHeight()", () => {
    it("returns height from SDK networkClient.getLatestHeight()", async () => {
      mockGetLatestHeight.mockResolvedValue(999);
      const connection = createDevnodeConnection();

      const height = await connection.getBlockHeight();

      expect(height).toBe(999);
      expect(mockGetLatestHeight).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // broadcastTransaction()
  // -------------------------------------------------------------------------

  describe("broadcastTransaction()", () => {
    it("submits transaction via SDK and returns txId", async () => {
      mockSubmitTransaction.mockResolvedValue("at1broadcast");
      const connection = createDevnodeConnection();

      const txId = await connection.broadcastTransaction("tx-bytes");

      expect(mockSubmitTransaction).toHaveBeenCalledWith("tx-bytes");
      expect(txId).toBe("at1broadcast");
    });

    it("strips surrounding quotes from txId", async () => {
      mockSubmitTransaction.mockResolvedValue('"at1quoted"');
      const connection = createDevnodeConnection();

      const txId = await connection.broadcastTransaction("tx-bytes");

      expect(txId).toBe("at1quoted");
    });

    it("converts non-string return to string", async () => {
      mockSubmitTransaction.mockResolvedValue(12345);
      const connection = createDevnodeConnection();

      const txId = await connection.broadcastTransaction("tx-bytes");

      expect(txId).toBe("12345");
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe("close()", () => {
    it("clears cached SDK objects so next call re-initializes", async () => {
      const connection = createDevnodeConnection();

      // First call initializes SDK
      await connection.getBlockHeight();
      expect(mockCreateSdkObjects).toHaveBeenCalledTimes(1);

      // Close clears cache
      await connection.close();

      // Next call re-initializes
      await connection.getBlockHeight();
      expect(mockCreateSdkObjects).toHaveBeenCalledTimes(2);
    });
  });
});
