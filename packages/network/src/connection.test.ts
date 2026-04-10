import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRun = vi.fn();
const mockCreateSdkObjects = vi.fn();
const mockCheckDevnodeSdkSupport = vi.fn();
const mockInitConsensusHeights = vi.fn();

vi.mock("./sdk-adapter.js", () => ({
  createSdkObjects: mockCreateSdkObjects,
  checkDevnodeSdkSupport: mockCheckDevnodeSdkSupport,
  initConsensusHeights: mockInitConsensusHeights,
}));

import { AleoConnection } from "./connection.js";

describe("AleoConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCreateSdkObjects.mockResolvedValue({
      account: {},
      networkClient: {
        getProgram: vi.fn().mockResolvedValue("program hello.aleo { }"),
        submitTransaction: vi.fn(),
      },
      programManager: {
        run: mockRun,
      },
      keyProvider: {},
      recordProvider: {},
    });
  });

  it("returns outputs from ExecutionResponse.getOutputs() for local execution", async () => {
    mockRun.mockResolvedValue({
      getOutputs: () => ["8u32"],
    });

    const connection = new AleoConnection({
      type: "devnode",
      name: "devnode",
      endpoint: "http://127.0.0.1:3030",
      networkId: "testnet",
      privateKey: "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
    });

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

  it("uses the devnode block creation endpoint when advancing blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    vi.stubGlobal("fetch", fetchMock);

    const connection = new AleoConnection({
      type: "devnode",
      name: "devnode",
      endpoint: "http://127.0.0.1:3030",
      networkId: "testnet",
    });

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
});
