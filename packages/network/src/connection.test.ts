import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRun = vi.fn();
const mockExecute = vi.fn();
const mockBuildDevnodeExec = vi.fn();
const mockSubmitTransaction = vi.fn();
const mockGetProgramMappingValue = vi.fn();
const mockGetLatestHeight = vi.fn();
const mockGetProgram = vi.fn();
const mockCreateSdkObjects = vi.fn();
const mockCreateSignerSdkObjects = vi.fn();
const mockCheckDevnodeSdkSupport = vi.fn();
const mockInitConsensusHeights = vi.fn();

vi.mock("./sdk-adapter.js", () => ({
  createSdkObjects: mockCreateSdkObjects,
  createSignerSdkObjects: mockCreateSignerSdkObjects,
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
  // extractLocalExecutionOutputs — fallback paths
  // -------------------------------------------------------------------------

  describe("extractLocalExecutionOutputs fallback paths", () => {
    it("handles SDK result as a direct array", async () => {
      // Path 1: pm.run() returns a plain array of strings
      mockRun.mockResolvedValue(["42u32", "7u64"]);

      const connection = createDevnodeConnection();
      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
      });

      expect(result.outputs).toEqual(["42u32", "7u64"]);
    });

    it("handles SDK result with .outputs property (no getOutputs method)", async () => {
      // Path 2b: pm.run() returns an object with an outputs array but no getOutputs()
      mockRun.mockResolvedValue({ outputs: ["99u128"] });

      const connection = createDevnodeConnection();
      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
      });

      expect(result.outputs).toEqual(["99u128"]);
    });

    it("returns empty array when SDK result is null", async () => {
      // Fallback: pm.run() returns null
      mockRun.mockResolvedValue(null);

      const connection = createDevnodeConnection();
      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
      });

      expect(result.outputs).toEqual([]);
    });

    it("returns empty array when SDK result is an object with no recognized shape", async () => {
      // Fallback: pm.run() returns an unrecognized object
      mockRun.mockResolvedValue({ something: "else" });

      const connection = createDevnodeConnection();
      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
      });

      expect(result.outputs).toEqual([]);
    });

    it("converts non-string array elements to strings", async () => {
      // Path 1: pm.run() returns array with non-string elements
      mockRun.mockResolvedValue([42, true, "hello"]);

      const connection = createDevnodeConnection();
      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
      });

      expect(result.outputs).toEqual(["42", "true", "hello"]);
    });

    it("returns empty array when getOutputs() returns a non-array", async () => {
      // Path 2a edge case: getOutputs() returns something unexpected
      mockRun.mockResolvedValue({ getOutputs: () => "not-an-array" });

      const connection = createDevnodeConnection();
      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
      });

      expect(result.outputs).toEqual([]);
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
        "http://127.0.0.1:3030/testnet/transaction/confirmed/at1test",
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

    it("returns rejected status for fee-only (rejected) transactions", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          transaction: { type: "fee" },
          block_height: 15,
        }),
      });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 15,
        status: "rejected",
      });
    });

    it("returns accepted status for execute transactions", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          transaction: { type: "execute" },
          block_height: 20,
        }),
      });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 20,
        status: "accepted",
      });
    });

    it("returns accepted status for deploy transactions", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          transaction: { type: "deploy" },
          block_height: 25,
        }),
      });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 25,
        status: "accepted",
      });
    });

    it("defaults to accepted when no transaction type is present", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ block_height: 42 }),
      });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result.status).toBe("accepted");
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
    it("rejects all public methods after close", async () => {
      const connection = createDevnodeConnection();

      await connection.close();

      await expect(connection.getBlockHeight()).rejects.toThrow("Connection is closed.");
      await expect(connection.getBalance("aleo1abc")).rejects.toThrow("Connection is closed.");
      await expect(connection.getMappingValue("t.aleo", "m", "k")).rejects.toThrow("Connection is closed.");
      await expect(connection.execute("t.aleo", "f", [])).rejects.toThrow("Connection is closed.");
      await expect(connection.waitForConfirmation("at1x")).rejects.toThrow("Connection is closed.");
      await expect(connection.broadcastTransaction("tx")).rejects.toThrow("Connection is closed.");
      await expect(connection.advanceBlocks!(1)).rejects.toThrow("Connection is closed.");
    });

    it("calls account.destroy() on resolved signer accounts", async () => {
      const signerDestroy = vi.fn();
      const signerPm = { run: mockRun, execute: mockExecute, buildDevnodeExecutionTransaction: mockBuildDevnodeExec };
      mockCreateSignerSdkObjects.mockResolvedValue({
        account: { destroy: signerDestroy },
        recordProvider: {},
        programManager: signerPm,
      });

      const connection = createDevnodeConnection();

      // Trigger signer SDK creation
      await connection.execute("hello.aleo", "main", ["1u32"], {
        signer: { privateKey: "APrivateKey1zkpSigner", address: "aleo1signer" },
      });

      await connection.close();
      expect(signerDestroy).toHaveBeenCalledOnce();
    });

    it("calls account.destroy() on default account", async () => {
      const defaultDestroy = vi.fn();
      mockCreateSdkObjects.mockResolvedValue({
        account: { destroy: defaultDestroy, address: () => ({ to_string: () => "aleo1d" }) },
        networkClient: { getProgram: mockGetProgram, submitTransaction: mockSubmitTransaction, getProgramMappingValue: mockGetProgramMappingValue, getLatestHeight: mockGetLatestHeight },
        programManager: { run: mockRun, execute: mockExecute, buildDevnodeExecutionTransaction: mockBuildDevnodeExec },
        keyProvider: {},
        recordProvider: {},
      });

      const connection = createDevnodeConnection();
      await connection.getBlockHeight(); // force SDK init
      await connection.close();
      expect(defaultDestroy).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Signer switching
  // -------------------------------------------------------------------------

  describe("signer switching", () => {
    const signerKey = "APrivateKey1zkpSignerKey";
    const signerAddress = "aleo1signeraddr";

    const signerRunMock = vi.fn();
    const signerExecuteMock = vi.fn();
    const signerBuildDevnodeMock = vi.fn();

    beforeEach(() => {
      signerRunMock.mockReset();
      signerExecuteMock.mockResolvedValue("at1signer");
      signerBuildDevnodeMock.mockResolvedValue("mock-signer-tx");

      mockCreateSignerSdkObjects.mockResolvedValue({
        account: { destroy: vi.fn() },
        recordProvider: {},
        programManager: {
          run: signerRunMock,
          execute: signerExecuteMock,
          buildDevnodeExecutionTransaction: signerBuildDevnodeMock,
        },
      });
    });

    it("uses the signer's PM for on-chain execution, not the default", async () => {
      const connection = createDevnodeConnection();

      await connection.execute("hello.aleo", "main", ["1u32"], {
        signer: { privateKey: signerKey, address: signerAddress },
      });

      // Signer PM was used
      expect(signerBuildDevnodeMock).toHaveBeenCalledOnce();
      // Default PM was not used
      expect(mockBuildDevnodeExec).not.toHaveBeenCalled();
    });

    it("uses the signer's PM for local execution", async () => {
      signerRunMock.mockResolvedValue({ getOutputs: () => ["99u32"] });

      const connection = createDevnodeConnection();

      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
        signer: { privateKey: signerKey, address: signerAddress },
      });

      expect(signerRunMock).toHaveBeenCalledOnce();
      expect(mockRun).not.toHaveBeenCalled();
      expect(result.outputs).toEqual(["99u32"]);
    });

    it("uses default PM when no signer override is given", async () => {
      const connection = createDevnodeConnection();

      await connection.execute("hello.aleo", "main", ["1u32"]);

      expect(mockBuildDevnodeExec).toHaveBeenCalledOnce();
      expect(signerBuildDevnodeMock).not.toHaveBeenCalled();
    });

    it("uses default PM when signer key matches connection key", async () => {
      const connection = createDevnodeConnection();
      const defaultKey = "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH";

      await connection.execute("hello.aleo", "main", ["1u32"], {
        signer: { privateKey: defaultKey, address: "aleo1default" },
      });

      expect(mockBuildDevnodeExec).toHaveBeenCalledOnce();
      expect(mockCreateSignerSdkObjects).not.toHaveBeenCalled();
    });

    it("caches signer SDK objects across calls with the same key", async () => {
      const connection = createDevnodeConnection();
      const signer = { privateKey: signerKey, address: signerAddress };

      await connection.execute("hello.aleo", "main", ["1u32"], { signer });
      await connection.execute("hello.aleo", "main", ["2u32"], { signer });

      expect(mockCreateSignerSdkObjects).toHaveBeenCalledOnce();
      expect(signerBuildDevnodeMock).toHaveBeenCalledTimes(2);
    });

    it("passes keyProvider and apiKey to createSignerSdkObjects", async () => {
      const connection = createDevnodeConnection({ apiKey: "my-api-key" });

      await connection.execute("hello.aleo", "main", ["1u32"], {
        signer: { privateKey: signerKey, address: signerAddress },
      });

      expect(mockCreateSignerSdkObjects).toHaveBeenCalledWith({
        privateKey: signerKey,
        endpoint: "http://127.0.0.1:3030",
        network: "testnet",
        keyProvider: {},
        apiKey: "my-api-key",
      });
    });

    it("evicts rejected signer creation from cache so retries work", async () => {
      mockCreateSignerSdkObjects
        .mockRejectedValueOnce(new Error("WASM init failed"))
        .mockResolvedValueOnce({
          account: { destroy: vi.fn() },
          recordProvider: {},
          programManager: {
            run: signerRunMock,
            execute: signerExecuteMock,
            buildDevnodeExecutionTransaction: signerBuildDevnodeMock,
          },
        });

      const connection = createDevnodeConnection();
      const signer = { privateKey: signerKey, address: signerAddress };

      // First call fails
      await expect(
        connection.execute("hello.aleo", "main", ["1u32"], { signer }),
      ).rejects.toThrow("WASM init failed");

      // Retry succeeds
      await connection.execute("hello.aleo", "main", ["1u32"], { signer });
      expect(mockCreateSignerSdkObjects).toHaveBeenCalledTimes(2);
      expect(signerBuildDevnodeMock).toHaveBeenCalledOnce();
    });
  });
});
