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
      undefined, // no imports for a program without import declarations
    );
  });

  // -------------------------------------------------------------------------
  // execute() — local mode: cross-program import fetching
  // -------------------------------------------------------------------------

  describe("local execution with cross-program imports", () => {
    it("fetches imports and passes them to pm.run() as 5th arg", async () => {
      const topSource =
        "import dep_a.aleo;\nimport dep_b.aleo;\nprogram top.aleo;\nfunction main:\n  output 1u32 as u32.private;\n";
      const depASource = "program dep_a.aleo;\nfunction helper:\n  output 1u32 as u32.private;\n";
      const depBSource = "program dep_b.aleo;\nfunction helper:\n  output 2u32 as u32.private;\n";

      mockGetProgram.mockImplementation(async (id: string) => {
        if (id === "top.aleo") return topSource;
        if (id === "dep_a.aleo") return depASource;
        if (id === "dep_b.aleo") return depBSource;
        throw new Error(`Unknown program: ${id}`);
      });
      mockRun.mockResolvedValue({ getOutputs: () => ["3u32"] });

      const connection = createDevnodeConnection();
      const result = await connection.execute("top.aleo", "main", [], {
        mode: "local",
      });

      expect(result.outputs).toEqual(["3u32"]);
      expect(mockRun).toHaveBeenCalledWith(
        topSource,
        "main",
        [],
        false,
        { "dep_a.aleo": depASource, "dep_b.aleo": depBSource },
      );
      // getProgram called 3 times: target + 2 imports
      expect(mockGetProgram).toHaveBeenCalledTimes(3);
    });

    it("passes undefined imports for programs without import declarations", async () => {
      mockRun.mockResolvedValue({ getOutputs: () => ["5u32"] });

      const connection = createDevnodeConnection();
      await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
      });

      expect(mockRun).toHaveBeenCalledWith(
        "program hello.aleo { }",
        "main",
        ["1u32"],
        false,
        undefined,
      );
    });
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

  // The real shape, captured live against `leo devnode` 4.0.2 — see bug record
  // `.lionden/bug-hunt/bugs/connection-block-height-field-shape.md`. The
  // `transaction/confirmed/<txId>` body has no `block_height` anywhere, so
  // `waitForConfirmation` does a three-call dance per confirmation:
  //   1. GET /<network>/transaction/confirmed/<txId>  -> tx body (status discriminator)
  //   2. GET /<network>/find/blockHash/<txId>         -> JSON-encoded block-hash string
  //   3. GET /<network>/block/<blockHash>             -> header.metadata.height (number)
  describe("waitForConfirmation()", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    const TEST_BLOCK_HASH =
      "ab1ajw276h6xe6hqswh87yr5ljjxf7dqtefxd6awhsp5znc36fupsqs8auddq";

    type MockOpts = {
      txType?: "execute" | "deploy" | "fee" | "missing";
      height?: number;
      blockHash?: string;
    };

    function mockHappyConfirmation({
      txType = "execute",
      height = 42,
      blockHash = TEST_BLOCK_HASH,
    }: MockOpts = {}) {
      const txBody: Record<string, unknown> = {
        status: "accepted",
        type: "execute",
        index: 0,
        finalize: [],
      };
      if (txType !== "missing") {
        txBody["transaction"] = { type: txType, id: "at1test" };
      }
      const blockBody = {
        block_hash: blockHash,
        header: { metadata: { network: 1, round: height, height } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: true, text: async () => JSON.stringify(blockHash) };
        }
        if (url.includes(`/block/${blockHash}`)) {
          return { ok: true, json: async () => blockBody };
        }
        throw new Error(`unexpected fetch ${url}`);
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns confirmed transaction on first successful poll", async () => {
      mockHappyConfirmation({ height: 42 });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 42,
        status: "accepted",
      });
    });

    it("hits all three real endpoints (confirmed, find/blockHash, block) with networkId and txId", async () => {
      mockHappyConfirmation({ height: 42 });
      const connection = createDevnodeConnection();

      await connection.waitForConfirmation("at1test");

      const calls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(calls).toContain(
        "http://127.0.0.1:3030/testnet/transaction/confirmed/at1test",
      );
      expect(calls).toContain(
        "http://127.0.0.1:3030/testnet/find/blockHash/at1test",
      );
      expect(calls).toContain(
        `http://127.0.0.1:3030/testnet/block/${TEST_BLOCK_HASH}`,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: {} }),
      );
    });

    it("includes Authorization header on every call when apiKey is set", async () => {
      mockHappyConfirmation();
      const connection = createDevnodeConnection({ apiKey: "mykey" });

      await connection.waitForConfirmation("at1test");

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init).toEqual(
          expect.objectContaining({
            headers: { Authorization: "Bearer mykey" },
          }),
        );
      }
    });

    it("retries when the confirmed-tx poll returns non-ok, succeeds on next poll", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test" },
      };
      const blockBody = {
        header: { metadata: { network: 1, round: 10, height: 10 } },
      };
      let confirmedHits = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          confirmedHits++;
          if (confirmedHits === 1) return { ok: false };
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return {
            ok: true,
            text: async () => JSON.stringify(TEST_BLOCK_HASH),
          };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => blockBody };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const connection = createDevnodeConnection();
      const promise = connection.waitForConfirmation("at1test", 10_000);
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;

      expect(confirmedHits).toBeGreaterThanOrEqual(2);
      expect(result.status).toBe("accepted");
      expect(result.blockHeight).toBe(10);
    });

    it("retries when the confirmed-tx poll throws, succeeds on next poll", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test" },
      };
      const blockBody = {
        header: { metadata: { network: 1, round: 5, height: 5 } },
      };
      let confirmedHits = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          confirmedHits++;
          if (confirmedHits === 1) throw new Error("ECONNREFUSED");
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return {
            ok: true,
            text: async () => JSON.stringify(TEST_BLOCK_HASH),
          };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => blockBody };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const connection = createDevnodeConnection();
      const promise = connection.waitForConfirmation("at1test", 10_000);
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;

      expect(confirmedHits).toBeGreaterThanOrEqual(2);
      expect(result.blockHeight).toBe(5);
    });

    it("throws after timeout expires when the confirmed-tx poll never succeeds", async () => {
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
      mockHappyConfirmation({ txType: "fee", height: 15 });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 15,
        status: "rejected",
      });
    });

    it("returns accepted status for execute transactions", async () => {
      mockHappyConfirmation({ txType: "execute", height: 20 });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 20,
        status: "accepted",
      });
    });

    it("returns accepted status for deploy transactions", async () => {
      mockHappyConfirmation({ txType: "deploy", height: 25 });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 25,
        status: "accepted",
      });
    });

    it("defaults to accepted when no transaction type is present", async () => {
      mockHappyConfirmation({ txType: "missing", height: 42 });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      expect(result.status).toBe("accepted");
    });

    it("throws if the find/blockHash lookup never resolves before the deadline", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test" },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: false };
        }
        return { ok: false };
      });
      const connection = createDevnodeConnection();

      const promise = connection.waitForConfirmation("at1test", 3_000);
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(4_000);

      await expect(promise).rejects.toThrow(
        "block-hash lookup did not resolve",
      );
    });

    it("throws if /block/<hash> never returns ok before the deadline (fail-closed)", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test" },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return {
            ok: true,
            text: async () => JSON.stringify(TEST_BLOCK_HASH),
          };
        }
        return { ok: false };
      });
      const connection = createDevnodeConnection();

      const promise = connection.waitForConfirmation("at1test", 3_000);
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(4_000);

      await expect(promise).rejects.toThrow(
        "block height could not be resolved",
      );
    });

    it("throws if /block/<hash> returns 200 but header.metadata.height is missing", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test" },
      };
      const malformedBlock = {
        block_hash: TEST_BLOCK_HASH,
        // header.metadata.height intentionally absent
        header: { metadata: { network: 1, round: 21 } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return {
            ok: true,
            text: async () => JSON.stringify(TEST_BLOCK_HASH),
          };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => malformedBlock };
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      const connection = createDevnodeConnection();

      await expect(
        connection.waitForConfirmation("at1test"),
      ).rejects.toThrow("header.metadata.height is missing or non-numeric");
    });

    it("throws if /block/<hash> returns 200 but header.metadata.height is non-numeric", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test" },
      };
      const malformedBlock = {
        block_hash: TEST_BLOCK_HASH,
        header: { metadata: { network: 1, round: 21, height: "21" } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return {
            ok: true,
            text: async () => JSON.stringify(TEST_BLOCK_HASH),
          };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => malformedBlock };
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      const connection = createDevnodeConnection();

      await expect(
        connection.waitForConfirmation("at1test"),
      ).rejects.toThrow("header.metadata.height is missing or non-numeric");
    });

    it("returns blockHeight 0 when the block JSON explicitly reports height 0 (genesis-adjacent)", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test" },
      };
      const genesisBlock = {
        block_hash: TEST_BLOCK_HASH,
        header: { metadata: { network: 1, round: 0, height: 0 } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return {
            ok: true,
            text: async () => JSON.stringify(TEST_BLOCK_HASH),
          };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => genesisBlock };
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      const connection = createDevnodeConnection();

      const result = await connection.waitForConfirmation("at1test");

      // 0 is now load-bearing: it means the block JSON said height 0, not
      // that the parser silently fell back. Discriminated by the explicit
      // numeric type-check at the read site.
      expect(result).toEqual({
        txId: "at1test",
        blockHeight: 0,
        status: "accepted",
      });
    });

    it("parses the block hash whether the find/blockHash body is JSON-quoted or bare", async () => {
      const txBody = {
        status: "accepted",
        transaction: { type: "execute", id: "at1test" },
      };
      const blockBody = {
        header: { metadata: { network: 1, round: 7, height: 7 } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: true, text: async () => TEST_BLOCK_HASH };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => blockBody };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const connection = createDevnodeConnection();
      const result = await connection.waitForConfirmation("at1test");

      expect(result.blockHeight).toBe(7);
    });

    // Regression test for bug `connection-block-height-field-shape`
    // (.lionden/bug-hunt/bugs/connection-block-height-field-shape.md).
    // Mocks the exact captured devnode shape and asserts the parser surfaces
    // the actual block height (21) rather than the old buggy default of 0.
    it("returns the real block height from the find/blockHash + block lookup", async () => {
      const acceptedBody = {
        status: "accepted",
        type: "execute",
        index: 0,
        transaction: { type: "execute", id: "at1real" },
        finalize: [],
      };
      const blockHash = "ab1ajw276h6xe6hqswh87yr5ljjxf7dqtefxd6awhsp5znc36fupsqs8auddq";
      const blockBody = {
        block_hash: blockHash,
        header: { metadata: { network: 1, round: 21, height: 21 } },
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith("/transaction/confirmed/at1real")) {
          return { ok: true, json: async () => acceptedBody };
        }
        if (url.endsWith("/find/blockHash/at1real")) {
          return { ok: true, text: async () => JSON.stringify(blockHash) };
        }
        if (url.endsWith(`/block/${blockHash}`)) {
          return { ok: true, json: async () => blockBody };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const connection = createDevnodeConnection();
      const result = await connection.waitForConfirmation("at1real");

      expect(result).toEqual({
        txId: "at1real",
        blockHeight: 21,
        status: "accepted",
      });
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
