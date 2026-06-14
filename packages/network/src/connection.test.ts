import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256Json, sha256Text } from "@lionden/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRuntimeKeyIdentity, writeCachedExecutionKeys } from "./execution-key-cache.js";

const mockRun = vi.fn();
const mockExecute = vi.fn();
const mockSynthesizeKeys = vi.fn();
const mockSynthesizeExecutionKeyBytes = vi.fn();
const mockBuildAuthorizationUnchecked = vi.fn();
const mockBuildDevnodeExec = vi.fn();
const mockSubmitTransaction = vi.fn();
const mockGetProgramMappingValue = vi.fn();
const mockGetLatestHeight = vi.fn();
const mockGetProgram = vi.fn();
const mockGetLatestProgramEdition = vi.fn();
const mockPrepareInputs = vi.fn();
const mockCreateSdkObjects = vi.fn();
const mockCreateSignerSdkObjects = vi.fn();
const mockCreateExecutionKeysFromBytes = vi.fn();
const mockGetSdkRuntimeMetadata = vi.fn();
const mockCheckDevnodeSdkSupport = vi.fn();
const mockInitConsensusHeights = vi.fn();

vi.mock("./sdk-adapter.js", () => ({
  createSdkObjects: mockCreateSdkObjects,
  createSignerSdkObjects: mockCreateSignerSdkObjects,
  createExecutionKeysFromBytes: mockCreateExecutionKeysFromBytes,
  synthesizeExecutionKeyBytes: mockSynthesizeExecutionKeyBytes,
  getSdkRuntimeMetadata: mockGetSdkRuntimeMetadata,
  checkDevnodeSdkSupport: mockCheckDevnodeSdkSupport,
  initConsensusHeights: mockInitConsensusHeights,
}));

import { AleoConnection } from "./connection.js";
import { SdkDiagnostics } from "./sdk-diagnostics.js";
import {
  LocalExecutionWasmTrapError,
  LocalVmExecutionError,
  NetworkConfirmationTimeoutError,
  SdkExecutionError,
  TransitionRejectedError,
  TransitionSelectionError,
} from "./types.js";

// Mirrors `TEST_DEVNODE_EGRESS_POLICY` in `@lionden/test-internals`; kept
// local because that package depends on `@lionden/network` (cycle).
const TEST_EGRESS_POLICY = {
  allowedNetworkHosts: new Set(["127.0.0.1:3030"]),
  violation: "block" as const,
};

// Minimal program ABI (as written beside main.aleo) whose transition has only
// a plaintext input. Cache misses defer regardless of this shape now; the ABI
// is still useful for exercising artifact resolution.
function recordFreeAbi(transition: string): string {
  return JSON.stringify({
    functions: [
      {
        name: transition,
        inputs: [{ name: "x", ty: { Plaintext: { Primitive: { UInt: "U32" } } }, mode: "Private" }],
      },
    ],
  });
}

// ABI whose transition consumes a record (`{ Record }`) or a `"DynamicRecord"`
// input. These shapes used to drive cache-miss policy and remain covered as
// regression evidence.
function recordInputAbi(
  transition: string,
  ty: unknown = { Record: { path: ["Token"], program: "tok.aleo" } },
): string {
  return JSON.stringify({
    functions: [{ name: transition, inputs: [{ name: "r", ty, mode: "None" }] }],
  });
}

function createDevnodeConnection(
  overrides?: Partial<ConstructorParameters<typeof AleoConnection>[0]>,
) {
  return new AleoConnection({
    type: "devnode",
    name: "devnode",
    endpoint: "http://127.0.0.1:3030",
    networkId: "testnet",
    privateKey: "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
    egressPolicy: TEST_EGRESS_POLICY,
    projectRoot: "/tmp/test",
    ...overrides,
  });
}

function createHttpConnection(
  overrides?: Partial<ConstructorParameters<typeof AleoConnection>[0]>,
) {
  return new AleoConnection({
    type: "http",
    name: "testnet",
    endpoint: "https://api.explorer.provable.com/v1",
    networkId: "testnet",
    privateKey: "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
    egressPolicy: TEST_EGRESS_POLICY,
    projectRoot: "/tmp/test",
    ...overrides,
  });
}

describe("AleoConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const mockPrivateKey = { kind: "private-key" };
    const mockAccount = {
      address: () => ({ to_string: () => "aleo1derived" }),
      privateKey: () => mockPrivateKey,
    };
    const mockProgramManagerBase = { kind: "ProgramManagerBase" };

    mockGetProgram.mockResolvedValue("program hello.aleo { }");
    mockSubmitTransaction.mockResolvedValue("at1broadcast");
    mockGetProgramMappingValue.mockResolvedValue("100u64");
    mockGetLatestHeight.mockResolvedValue(42);
    mockGetLatestProgramEdition.mockResolvedValue(3);
    mockBuildDevnodeExec.mockResolvedValue("mock-tx-bytes");
    mockExecute.mockResolvedValue("at1executed");
    mockBuildAuthorizationUnchecked.mockResolvedValue({ kind: "authorization" });
    mockSynthesizeKeys.mockResolvedValue([
      { toBytes: () => new Uint8Array([10, 11]) },
      { toBytes: () => new Uint8Array([12, 13]) },
    ]);
    mockSynthesizeExecutionKeyBytes.mockResolvedValue({
      provingKeyBytes: new Uint8Array([10, 11]),
      verifyingKeyBytes: new Uint8Array([12, 13]),
    });
    mockPrepareInputs.mockImplementation(
      (_source: string, _transition: string, inputs: string[]) => inputs,
    );
    mockCreateExecutionKeysFromBytes.mockImplementation(async (_network, bytes) => ({
      provingKey: { kind: "proving", bytes: [...bytes.provingKey] },
      verifyingKey: { kind: "verifying", bytes: [...bytes.verifyingKey] },
    }));
    mockGetSdkRuntimeMetadata.mockReturnValue({
      sdkVersion: "0.10.5",
      wasmVersion: "0.10.5",
      wasmHash: "f".repeat(64),
    });

    mockCreateSdkObjects.mockResolvedValue({
      account: mockAccount,
      networkClient: {
        getProgram: mockGetProgram,
        submitTransaction: mockSubmitTransaction,
        getProgramMappingValue: mockGetProgramMappingValue,
        getLatestHeight: mockGetLatestHeight,
        getLatestProgramEdition: mockGetLatestProgramEdition,
      },
      programManager: {
        run: mockRun,
        execute: mockExecute,
        synthesizeKeys: mockSynthesizeKeys,
        buildAuthorizationUnchecked: mockBuildAuthorizationUnchecked,
        prepareInputs: mockPrepareInputs,
        account: mockAccount,
        buildDevnodeExecutionTransaction: mockBuildDevnodeExec,
      },
      programManagerBase: mockProgramManagerBase,
      keyProvider: {},
      recordProvider: {},
      diagnostics: new SdkDiagnostics(),
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

  it("turns an uncaught WASM trap during local execution into a rejection", async () => {
    const hadCaptureCallback = process.hasUncaughtExceptionCaptureCallback();
    mockRun.mockImplementation(
      () =>
        new Promise(() => {
          setImmediate(() => {
            throw new WebAssembly.RuntimeError("unreachable");
          });
        }),
    );

    const connection = createDevnodeConnection();

    await expect(
      connection.execute("hello.aleo", "main", ["10u128", "11u128"], {
        mode: "local",
      }),
    ).rejects.toThrow(
      "Provable SDK local execution trapped outside the pm.run promise: unreachable",
    );

    if (!hadCaptureCallback) {
      expect(process.hasUncaughtExceptionCaptureCallback()).toBe(false);
    }
  });

  it("turns a WASM trap into a rejection when a real capture callback is already installed", async () => {
    const hadCaptureCallback = process.hasUncaughtExceptionCaptureCallback();
    const capturedByExistingCallback: unknown[] = [];
    const uncaughtExceptionListener = vi.fn();

    if (!hadCaptureCallback) {
      process.setUncaughtExceptionCaptureCallback((error) => {
        capturedByExistingCallback.push(error);
      });
    }
    process.once("uncaughtException", uncaughtExceptionListener);

    mockRun.mockImplementation(
      () =>
        new Promise(() => {
          setImmediate(() => {
            throw new WebAssembly.RuntimeError("unreachable");
          });
        }),
    );

    const connection = createDevnodeConnection();

    try {
      expect(process.hasUncaughtExceptionCaptureCallback()).toBe(true);
      await expect(
        connection.execute("hello.aleo", "main", ["10u128", "11u128"], {
          mode: "local",
        }),
      ).rejects.toThrow(
        "Provable SDK local execution trapped outside the pm.run promise: unreachable",
      );
      expect(uncaughtExceptionListener).not.toHaveBeenCalled();
      if (!hadCaptureCallback) {
        expect(capturedByExistingCallback).toHaveLength(1);
        expect(capturedByExistingCallback[0]).toBeInstanceOf(WebAssembly.RuntimeError);
        expect(process.hasUncaughtExceptionCaptureCallback()).toBe(true);
      }
    } finally {
      process.removeListener("uncaughtException", uncaughtExceptionListener);
      if (!hadCaptureCallback) {
        process.setUncaughtExceptionCaptureCallback(null);
      }
    }
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
      expect(mockRun).toHaveBeenCalledWith(topSource, "main", [], false, {
        "dep_a.aleo": depASource,
        "dep_b.aleo": depBSource,
      });
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
  // checkLocalExecution() — failure-helper path
  // -------------------------------------------------------------------------

  describe("checkLocalExecution()", () => {
    it("uses buildAuthorizationUnchecked with resolved source", async () => {
      const connection = createDevnodeConnection();

      await connection.checkLocalExecution("hello.aleo", "main", ["1u32"]);

      expect(mockCheckDevnodeSdkSupport).toHaveBeenCalledOnce();
      expect(mockInitConsensusHeights).toHaveBeenCalledOnce();
      expect(mockBuildAuthorizationUnchecked).toHaveBeenCalledWith({
        programName: "hello.aleo",
        functionName: "main",
        inputs: ["1u32"],
        programSource: "program hello.aleo { }",
      });
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("passes runtime imports to buildAuthorizationUnchecked", async () => {
      mockGetProgram.mockImplementation(async (id: string) => {
        if (id === "governance.aleo") return "program governance.aleo { }";
        if (id === "voting_power.aleo") return "program voting_power.aleo;";
        throw new Error(`unexpected ${id}`);
      });

      const connection = createDevnodeConnection({
        executionImports: {
          "governance.aleo": [{ kind: "programId", programId: "voting_power.aleo" }],
        },
      });

      await connection.checkLocalExecution("governance.aleo", "main", []);

      expect(mockBuildAuthorizationUnchecked).toHaveBeenCalledWith(
        expect.objectContaining({
          programSource: "program governance.aleo { }",
          programImports: { "voting_power.aleo": "program voting_power.aleo;" },
        }),
      );
    });

    it("respects signer override", async () => {
      const signerBuildAuthorizationUnchecked = vi.fn().mockResolvedValue({ kind: "signer-auth" });
      const signer = {
        privateKey: "APrivateKey1zkpSigner",
        address: "aleo1signer",
      };
      mockCreateSignerSdkObjects.mockResolvedValue({
        account: { privateKey: () => ({ kind: "signer-private-key" }) },
        programManager: {
          run: mockRun,
          execute: mockExecute,
          buildAuthorizationUnchecked: signerBuildAuthorizationUnchecked,
          buildDevnodeExecutionTransaction: mockBuildDevnodeExec,
        },
        recordProvider: {},
        programManagerBase: { kind: "signer-base" },
        diagnostics: new SdkDiagnostics(),
      });

      const connection = createDevnodeConnection();

      await connection.checkLocalExecution("hello.aleo", "main", ["1u32"], { signer });

      expect(mockCreateSignerSdkObjects).toHaveBeenCalledOnce();
      expect(signerBuildAuthorizationUnchecked).toHaveBeenCalledWith(
        expect.objectContaining({
          programName: "hello.aleo",
          functionName: "main",
        }),
      );
      expect(mockBuildAuthorizationUnchecked).not.toHaveBeenCalled();
    });

    it("wraps vetted VM failures in LocalVmExecutionError", async () => {
      mockBuildAuthorizationUnchecked.mockRejectedValueOnce(
        "Stack authorization failed: Stack evaluation failed: assertion failed",
      );
      const connection = createDevnodeConnection();

      await expect(
        connection.checkLocalExecution("hello.aleo", "main", ["1u32"]),
      ).rejects.toBeInstanceOf(LocalVmExecutionError);
      await expect(
        connection.checkLocalExecution("hello.aleo", "main", ["1u32"]),
      ).resolves.toBeUndefined();
    });

    it("wraps captured WASM traps in LocalVmExecutionError", async () => {
      const hadCaptureCallback = process.hasUncaughtExceptionCaptureCallback();
      mockBuildAuthorizationUnchecked.mockImplementation(
        () =>
          new Promise(() => {
            setImmediate(() => {
              throw new WebAssembly.RuntimeError("unreachable");
            });
          }),
      );
      const connection = createDevnodeConnection();

      let thrown: unknown;
      try {
        await connection.checkLocalExecution("hello.aleo", "main", ["1u32"]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LocalVmExecutionError);
      expect(thrown).toMatchObject({
        kind: "LocalVmExecutionError",
        programId: "hello.aleo",
        transitionName: "main",
      });
      expect((thrown as Error).cause).toBeInstanceOf(LocalExecutionWasmTrapError);
      expect(process.hasUncaughtExceptionCaptureCallback()).toBe(hadCaptureCallback);
    });

    it("treats VM failures as catchable only with vetted SDK prefixes", async () => {
      mockBuildAuthorizationUnchecked.mockRejectedValueOnce(
        new Error("Error: Stack authorization failed: Stack evaluation failed: assertion failed"),
      );
      const connection = createDevnodeConnection();

      let thrown: unknown;
      try {
        await connection.checkLocalExecution("hello.aleo", "main", ["1u32"]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(LocalVmExecutionError);
      expect((thrown as Error).message).toBe(
        "Error: Stack authorization failed: Stack evaluation failed: assertion failed",
      );
    });

    it("rethrows infrastructure errors unchanged", async () => {
      const infra = new Error("PROBE-FETCH-DENY: blocked egress");
      mockBuildAuthorizationUnchecked.mockRejectedValueOnce(infra);
      const connection = createDevnodeConnection();

      await expect(connection.checkLocalExecution("hello.aleo", "main", ["1u32"])).rejects.toBe(
        infra,
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
        program: "program hello.aleo { }",
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
        program: "program hello.aleo { }",
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
        program: "program hello.aleo { }",
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
        diagnostics: new SdkDiagnostics(),
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
        program: "program hello.aleo { }",
      });
      expect(result.txId).toBe("at1executed");
    });

    // -----------------------------------------------------------------------
    // execute() — runtime imports (dynamic dispatch)
    // -----------------------------------------------------------------------

    describe("runtime imports", () => {
      it("threads config-level imports into devnode fast-path", async () => {
        mockGetProgram.mockImplementation(async (id: string) => {
          if (id === "governance.aleo") return "program governance.aleo { }";
          if (id === "voting_power.aleo") return "program voting_power.aleo;";
          throw new Error(`unexpected ${id}`);
        });

        const connection = createDevnodeConnection({
          executionImports: {
            "governance.aleo": [{ kind: "programId", programId: "voting_power.aleo" }],
          },
        });

        await connection.execute("governance.aleo", "main", []);

        expect(mockBuildDevnodeExec).toHaveBeenCalledWith(
          expect.objectContaining({
            program: "program governance.aleo { }",
            imports: { "voting_power.aleo": "program voting_power.aleo;" },
          }),
        );
      });

      it("threads per-call options.imports into pm.execute for http", async () => {
        mockGetProgram.mockImplementation(async (id: string) => {
          if (id === "governance.aleo") return "program governance.aleo { }";
          if (id === "voting_power.aleo") return "program voting_power.aleo;";
          throw new Error(`unexpected ${id}`);
        });

        const connection = createHttpConnection();

        await connection.execute("governance.aleo", "main", [], {
          imports: ["voting_power"],
        });

        expect(mockExecute).toHaveBeenCalledWith(
          expect.objectContaining({
            program: "program governance.aleo { }",
            imports: { "voting_power.aleo": "program voting_power.aleo;" },
          }),
        );
      });

      it("merges config-level and per-call imports (additive, deduped)", async () => {
        mockGetProgram.mockImplementation(async (id: string) => {
          if (id === "governance.aleo") return "program governance.aleo { }";
          if (id === "voting_power.aleo") return "program voting_power.aleo;";
          if (id === "quadratic_power.aleo") return "program quadratic_power.aleo;";
          throw new Error(`unexpected ${id}`);
        });

        const connection = createHttpConnection({
          executionImports: {
            "governance.aleo": [{ kind: "programId", programId: "voting_power.aleo" }],
          },
        });

        await connection.execute("governance.aleo", "main", [], {
          imports: ["voting_power", "quadratic_power.aleo"], // first dups config layer
        });

        expect(mockExecute).toHaveBeenCalledWith(
          expect.objectContaining({
            imports: {
              "quadratic_power.aleo": "program quadratic_power.aleo;",
              "voting_power.aleo": "program voting_power.aleo;",
            },
          }),
        );
      });

      it("forwards imports to pm.run in local mode", async () => {
        mockRun.mockResolvedValue({ getOutputs: () => ["100u64"] });
        mockGetProgram.mockImplementation(async (id: string) => {
          if (id === "governance.aleo") return "program governance.aleo { }";
          if (id === "voting_power.aleo") return "program voting_power.aleo;";
          throw new Error(`unexpected ${id}`);
        });

        const connection = createDevnodeConnection({
          executionImports: {
            "governance.aleo": [{ kind: "programId", programId: "voting_power.aleo" }],
          },
        });

        await connection.execute("governance.aleo", "main", [], { mode: "local" });

        expect(mockRun).toHaveBeenCalledWith("program governance.aleo { }", "main", [], false, {
          "voting_power.aleo": "program voting_power.aleo;",
        });
      });

      it("raises a clear error when a per-call path ref does not exist", async () => {
        const connection = createDevnodeConnection();

        await expect(
          connection.execute("hello.aleo", "main", ["1u32"], {
            imports: ["./does-not-exist.aleo"],
          }),
        ).rejects.toThrow(/Runtime import path not found/);
      });
    });

    it("injects cached filesystem keys and local program source without fetching the program", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-connection-cache-"));
      try {
        const artifactsDir = path.join(tmpDir, "artifacts");
        const artifactDir = path.join(artifactsDir, "hello.aleo");
        const cachePath = path.join(tmpDir, ".aleo");
        const source = "program hello.aleo { }";
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);

        const identity = buildRuntimeKeyIdentity({
          network: "testnet",
          programId: "hello.aleo",
          transition: "main",
          edition: 3,
          sourceHash: sha256Text(source),
          importsHash: sha256Json({ imports: [] }),
          wasmHash: "f".repeat(64),
        });
        // Production no longer writes runtime user-program entries on execution
        // misses; this injected entry verifies that legacy/sidecar-warmed hits
        // still thread through to pm.execute.
        writeCachedExecutionKeys(
          {
            identity,
            provingKeyBytes: new Uint8Array([1, 2, 3]),
            verifyingKeyBytes: new Uint8Array([4, 5]),
          },
          cachePath,
        );

        const connection = createHttpConnection({
          artifactsDir,
          keyCache: { storage: "filesystem", path: cachePath },
        });

        await connection.execute("hello.aleo", "main", ["1u32"]);

        expect(mockGetProgram).not.toHaveBeenCalled();
        expect(mockSynthesizeKeys).not.toHaveBeenCalled();
        expect(mockExecute).toHaveBeenCalledWith(
          expect.objectContaining({
            programName: "hello.aleo",
            functionName: "main",
            program: source,
            edition: 3,
            provingKey: { kind: "proving", bytes: [1, 2, 3] },
            verifyingKey: { kind: "verifying", bytes: [4, 5] },
          }),
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("defers filesystem key-cache misses to pm.execute lazy synthesis", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-connection-cache-"));
      try {
        const artifactsDir = path.join(tmpDir, "artifacts");
        const artifactDir = path.join(artifactsDir, "hello.aleo");
        const cachePath = path.join(tmpDir, ".aleo");
        const source = "program hello.aleo { }";
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);
        fs.writeFileSync(path.join(artifactDir, "abi.json"), recordFreeAbi("main"));

        const connection = createHttpConnection({
          artifactsDir,
          keyCache: { storage: "filesystem", path: cachePath },
        });

        await connection.execute("hello.aleo", "main", ["1u32"]);

        expect(mockSynthesizeKeys).not.toHaveBeenCalled();
        expect(mockPrepareInputs).not.toHaveBeenCalled();
        expect(mockSynthesizeExecutionKeyBytes).not.toHaveBeenCalled();
        expect(mockCreateExecutionKeysFromBytes).not.toHaveBeenCalled();
        expect(mockExecute).toHaveBeenCalledWith(
          expect.objectContaining({
            programName: "hello.aleo",
            functionName: "main",
            program: source,
            edition: 3,
          }),
        );
        expect(mockExecute.mock.calls[0]![0]).not.toHaveProperty("provingKey");
        expect(mockExecute.mock.calls[0]![0]).not.toHaveProperty("verifyingKey");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("defers filesystem misses while still resolving recursive local imports", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-connection-cache-"));
      try {
        const artifactsDir = path.join(tmpDir, "artifacts");
        const cachePath = path.join(tmpDir, ".aleo");
        const appSource =
          "import foo.aleo;\nprogram app.aleo;\nfunction main:\n  output 1u32 as u32.private;\n";
        const fooSource =
          "import bar.aleo;\nprogram foo.aleo;\nfunction helper:\n  output 1u32 as u32.private;\n";
        const barSource = "program bar.aleo;\nfunction helper:\n  output 2u32 as u32.private;\n";

        for (const [programId, source] of [
          ["app.aleo", appSource],
          ["foo.aleo", fooSource],
          ["bar.aleo", barSource],
        ] as const) {
          const artifactDir = path.join(artifactsDir, programId);
          fs.mkdirSync(artifactDir, { recursive: true });
          fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);
          fs.writeFileSync(
            path.join(artifactDir, "abi.json"),
            recordFreeAbi(programId === "app.aleo" ? "main" : "helper"),
          );
        }

        const connection = createHttpConnection({
          artifactsDir,
          keyCache: { storage: "filesystem", path: cachePath },
        });

        await connection.execute("app.aleo", "main", ["1u32"]);

        const expectedImports = {
          "bar.aleo": barSource,
          "foo.aleo": fooSource,
        };
        expect(mockGetProgram).not.toHaveBeenCalled();
        expect(mockSynthesizeKeys).not.toHaveBeenCalled();
        expect(mockSynthesizeExecutionKeyBytes).not.toHaveBeenCalled();
        expect(mockExecute).toHaveBeenCalledWith(
          expect.objectContaining({
            program: appSource,
            imports: expectedImports,
          }),
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("defers filesystem misses without edition for not-yet-deployed programs", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-connection-cache-"));
      try {
        const artifactsDir = path.join(tmpDir, "artifacts");
        const artifactDir = path.join(artifactsDir, "hello.aleo");
        const cachePath = path.join(tmpDir, ".aleo");
        const source = "program hello.aleo { }";
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);
        fs.writeFileSync(path.join(artifactDir, "abi.json"), recordFreeAbi("main"));
        mockGetLatestProgramEdition.mockRejectedValueOnce(new Error("not deployed"));

        const connection = createDevnodeConnection({
          artifactsDir,
          keyCache: { storage: "filesystem", path: cachePath },
        });

        await connection.execute("hello.aleo", "main", ["1u32"], { prove: true });

        expect(mockSynthesizeExecutionKeyBytes).not.toHaveBeenCalled();
        expect(mockExecute.mock.calls[0]![0]).not.toHaveProperty("edition");
        expect(mockExecute.mock.calls[0]![0]).not.toHaveProperty("provingKey");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // Eager key synthesis runs the query-less WASM `synthesizeKeyPair`, which
    // cannot be guarded by LionDen's transport. On any cache miss we must NOT
    // eagerly synthesize — `pm.execute` synthesizes lazily with the CallbackQuery
    // wired to the active endpoint. Cache hits above are still injected.
    it.each([
      ["record", { Record: { path: ["Token"], program: "tok.aleo" } }],
      ["dynamic record", "DynamicRecord"],
    ])("skips eager synthesis on a cache miss for a transition with a %s input", async (_label, ty) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-connection-cache-"));
      try {
        const artifactsDir = path.join(tmpDir, "artifacts");
        const artifactDir = path.join(artifactsDir, "hello.aleo");
        const cachePath = path.join(tmpDir, ".aleo");
        const source = "program hello.aleo { }";
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);
        fs.writeFileSync(path.join(artifactDir, "abi.json"), recordInputAbi("main", ty));

        const connection = createDevnodeConnection({
          artifactsDir,
          keyCache: { storage: "filesystem", path: cachePath },
        });

        await connection.execute("hello.aleo", "main", ["1u32"], { prove: true });

        expect(mockSynthesizeExecutionKeyBytes).not.toHaveBeenCalled();
        // Execution still proceeds — keys synthesize lazily inside pm.execute.
        expect(mockExecute).toHaveBeenCalledOnce();
        expect(mockExecute.mock.calls[0]![0]).not.toHaveProperty("provingKey");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not enter the SDK SnapshotQuery egress path for a record-consuming cache miss", async () => {
      const { makeNetworkTransport } =
        await vi.importActual<typeof import("./sdk-adapter.js")>("./sdk-adapter.js");
      const guardedTransport = makeNetworkTransport(
        TEST_EGRESS_POLICY.allowedNetworkHosts,
        TEST_EGRESS_POLICY.violation,
      );
      const attemptedSnapshotQueries: string[] = [];
      mockSynthesizeExecutionKeyBytes.mockImplementation(async () => {
        const url = "https://api.provable.com/v2/testnet/statePaths";
        attemptedSnapshotQueries.push(url);
        await guardedTransport(url);
        throw new Error("eager key synthesis attempted SDK SnapshotQuery egress");
      });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-connection-cache-"));
      try {
        const artifactsDir = path.join(tmpDir, "artifacts");
        const artifactDir = path.join(artifactsDir, "hello.aleo");
        const cachePath = path.join(tmpDir, ".aleo");
        const source = "program hello.aleo { }";
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);
        fs.writeFileSync(path.join(artifactDir, "abi.json"), recordInputAbi("main"));

        const connection = createDevnodeConnection({
          artifactsDir,
          keyCache: { storage: "filesystem", path: cachePath },
        });

        await connection.execute("hello.aleo", "main", ["1u32"], { prove: true });

        expect(mockSynthesizeExecutionKeyBytes).not.toHaveBeenCalled();
        expect(attemptedSnapshotQueries).toEqual([]);
        expect(mockExecute).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // Conservative default: when the ABI can't be located (no abi.json), a miss
    // still defers to lazy pm.execute synthesis.
    it("skips eager synthesis on a cache miss when the ABI is unavailable", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-connection-cache-"));
      try {
        const artifactsDir = path.join(tmpDir, "artifacts");
        const artifactDir = path.join(artifactsDir, "hello.aleo");
        const cachePath = path.join(tmpDir, ".aleo");
        const source = "program hello.aleo { }";
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);
        // No abi.json written.

        const connection = createDevnodeConnection({
          artifactsDir,
          keyCache: { storage: "filesystem", path: cachePath },
        });

        await connection.execute("hello.aleo", "main", ["1u32"], { prove: true });

        expect(mockSynthesizeExecutionKeyBytes).not.toHaveBeenCalled();
        expect(mockExecute).toHaveBeenCalledOnce();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns { outputs: [], txId } for onchain execution", async () => {
      const connection = createDevnodeConnection();

      const result = await connection.execute("hello.aleo", "main", ["1u32"]);

      expect(result.outputs).toEqual([]);
      expect(result.txId).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // execute() — SdkExecutionError enrichment of opaque WASM prove failures
    // -----------------------------------------------------------------------

    describe("SdkExecutionError enrichment", () => {
      const STATE_PATHS_FAILURE = {
        method: "GET",
        url: "http://127.0.0.1:3030/testnet/statePaths?commitments=123field",
        status: 500,
        statusText: "Internal Server Error",
        bodyExcerpt: "Commitment '123field' does not exist",
        at: 0,
      };

      function mockSdkWithDiagnostics(diagnostics: SdkDiagnostics) {
        mockCreateSdkObjects.mockResolvedValue({
          account: {
            address: () => ({ to_string: () => "aleo1derived" }),
            privateKey: () => ({ kind: "private-key" }),
          },
          networkClient: {
            getProgram: mockGetProgram,
            submitTransaction: mockSubmitTransaction,
            getProgramMappingValue: mockGetProgramMappingValue,
            getLatestHeight: mockGetLatestHeight,
            getLatestProgramEdition: mockGetLatestProgramEdition,
          },
          programManager: {
            run: mockRun,
            execute: mockExecute,
            buildAuthorizationUnchecked: mockBuildAuthorizationUnchecked,
            prepareInputs: mockPrepareInputs,
            buildDevnodeExecutionTransaction: mockBuildDevnodeExec,
          },
          programManagerBase: { kind: "ProgramManagerBase" },
          keyProvider: {},
          recordProvider: {},
          diagnostics,
        });
      }

      it("wraps a pm.execute rejection that recorded a statePaths 500", async () => {
        const diagnostics = new SdkDiagnostics();
        mockSdkWithDiagnostics(diagnostics);
        const original = new Error("JS callback Promise rejected:");
        mockExecute.mockImplementation(async () => {
          diagnostics.record(STATE_PATHS_FAILURE);
          throw original;
        });

        const connection = createDevnodeConnection();
        const run = () =>
          connection.execute("token_router.aleo", "route_transfer", ["1u32"], { prove: true });

        await expect(run()).rejects.toMatchObject({
          kind: "SdkExecutionError",
          operation: "execute",
          programId: "token_router.aleo",
          transitionName: "route_transfer",
        });
        await expect(run()).rejects.toThrow(/statePaths.*500.*does not exist/);

        let thrown: unknown;
        try {
          await run();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(SdkExecutionError);
        expect((thrown as SdkExecutionError).cause).toBe(original);
        expect((thrown as SdkExecutionError).diagnostics).toHaveLength(1);
      });

      it("wraps a devnode fast-path build rejection that recorded a statePaths 500", async () => {
        const diagnostics = new SdkDiagnostics();
        mockSdkWithDiagnostics(diagnostics);
        const original = new Error("JS callback Promise rejected:");
        mockBuildDevnodeExec.mockImplementation(async () => {
          diagnostics.record(STATE_PATHS_FAILURE);
          throw original;
        });

        const connection = createDevnodeConnection();
        // No `prove` -> the devnode fast-path build is used.
        await expect(
          connection.execute("token_router.aleo", "route_transfer", ["1u32"]),
        ).rejects.toMatchObject({
          kind: "SdkExecutionError",
          operation: "execute",
          programId: "token_router.aleo",
          transitionName: "route_transfer",
        });
      });

      it("rethrows a non-opaque pm.execute rejection unchanged when nothing was recorded", async () => {
        const diagnostics = new SdkDiagnostics();
        mockSdkWithDiagnostics(diagnostics);
        const original = new Error("Stack evaluation failed: assertion failed");
        mockExecute.mockRejectedValue(original);

        const connection = createDevnodeConnection();
        await expect(
          connection.execute("hello.aleo", "main", ["1u32"], { prove: true }),
        ).rejects.toBe(original);
      });

      it("rethrows a pm.execute broadcast failure unchanged (not a state-query error)", async () => {
        // pm.execute() builds+proves THEN broadcasts internally; a broadcast 400
        // recorded by the transport must not be relabeled as a build/prove
        // state-query error — the descriptive broadcast error passes through.
        const diagnostics = new SdkDiagnostics();
        mockSdkWithDiagnostics(diagnostics);
        const original = new Error("Transaction broadcast rejected: invalid fee");
        mockExecute.mockImplementation(async () => {
          diagnostics.record({
            method: "POST",
            url: "http://127.0.0.1:3030/testnet/transaction/broadcast",
            status: 400,
            statusText: "Bad Request",
            bodyExcerpt: "invalid fee",
            at: 0,
          });
          throw original;
        });

        const connection = createDevnodeConnection();
        await expect(
          connection.execute("hello.aleo", "main", ["1u32"], { prove: true }),
        ).rejects.toBe(original);
      });
    });

    // -----------------------------------------------------------------------
    // On-chain build/prove WASM trap capture (regression for the on-chain
    // variant of the local-exec hang — see the tmp/bug-hunts/onchain-trap probe).
    // A transition-body arithmetic panic (under/overflow, div-by-zero) on the
    // execute paths emits a `RuntimeError: unreachable` trap that escapes the
    // SDK promise; runWithLocalWasmTrapCapture converts it to a rejection
    // instead of a hang. Both escape channels are covered:
    //   - uncaughtException  -> pm.execute (prove path)  [setImmediate throw]
    //   - unhandledRejection -> buildDevnodeExecutionTransaction (fast path)
    // -----------------------------------------------------------------------
    describe("on-chain build/prove WASM trap capture", () => {
      it("turns a fast-path build trap (uncaughtException) into a rejection", async () => {
        mockBuildDevnodeExec.mockImplementation(
          () =>
            new Promise(() => {
              setImmediate(() => {
                throw new WebAssembly.RuntimeError("unreachable");
              });
            }),
        );

        const connection = createDevnodeConnection();
        // No `prove` -> the devnode fast-path build is used.
        await expect(connection.execute("hello.aleo", "main", ["1u32"])).rejects.toThrow(
          "Provable SDK local execution trapped outside the pm.run promise: unreachable",
        );
      });

      it("turns a fast-path build trap that escapes as an unhandledRejection into a rejection", async () => {
        // The real devnode fast-path builder rejects an internal promise that is
        // never awaited — the trap surfaces as an unhandledRejection, not an
        // uncaughtException (observed by the onchain-trap probe).
        mockBuildDevnodeExec.mockImplementation(
          () =>
            new Promise(() => {
              void Promise.reject(new WebAssembly.RuntimeError("unreachable"));
            }),
        );

        const connection = createDevnodeConnection();
        await expect(connection.execute("hello.aleo", "main", ["1u32"])).rejects.toThrow(
          "Provable SDK local execution trapped outside the pm.run promise: unreachable",
        );
      });

      it("turns a prove-path pm.execute trap (uncaughtException) into a rejection", async () => {
        mockExecute.mockImplementation(
          () =>
            new Promise(() => {
              setImmediate(() => {
                throw new WebAssembly.RuntimeError("unreachable");
              });
            }),
        );

        const connection = createDevnodeConnection();
        await expect(
          connection.execute("hello.aleo", "main", ["1u32"], { prove: true }),
        ).rejects.toThrow(
          "Provable SDK local execution trapped outside the pm.run promise: unreachable",
        );
      });
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
      expect(mockGetProgramMappingValue).toHaveBeenCalledWith("token.aleo", "balances", "aleo1abc");
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

      await expect(connection.getBalance()).rejects.toThrow("No address specified");
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

    const TEST_BLOCK_HASH = "ab1ajw276h6xe6hqswh87yr5ljjxf7dqtefxd6awhsp5znc36fupsqs8auddq";

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
        // Provide a minimal valid execute body. The parser is now strict for
        // "execute" txs — a body with type "execute" must carry
        // transaction.execution.transitions[] or it's a shape error. These
        // tests don't exercise the parser surface; they validate the
        // polling/timeout/block-resolution loops, so a default empty
        // transitions[] is the right knob.
        const txObj: Record<string, unknown> = { type: txType, id: "at1test" };
        if (txType === "execute") {
          txObj.execution = { transitions: [] };
        }
        txBody["transaction"] = txObj;
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
        transitions: [],
      });
    });

    it("hits all three real endpoints (confirmed, find/blockHash, block) with networkId and txId", async () => {
      mockHappyConfirmation({ height: 42 });
      const connection = createDevnodeConnection();

      await connection.waitForConfirmation("at1test");

      const calls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(calls).toContain("http://127.0.0.1:3030/testnet/transaction/confirmed/at1test");
      expect(calls).toContain("http://127.0.0.1:3030/testnet/find/blockHash/at1test");
      expect(calls).toContain(`http://127.0.0.1:3030/testnet/block/${TEST_BLOCK_HASH}`);
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
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
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
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
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
      await expect(promise).rejects.toMatchObject({
        kind: "NetworkConfirmationTimeoutError",
        txId: "at1test",
        timeout: 3_000,
        stage: "confirmed",
      });
      await expect(promise).rejects.toBeInstanceOf(NetworkConfirmationTimeoutError);
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
        transitions: [],
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
        transitions: [],
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
        transitions: [],
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
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
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

      await expect(promise).rejects.toThrow("block-hash lookup did not resolve");
      await expect(promise).rejects.toMatchObject({
        kind: "NetworkConfirmationTimeoutError",
        stage: "blockHash",
      });
    });

    it("throws if /block/<hash> never returns ok before the deadline (fail-closed)", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
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

      await expect(promise).rejects.toThrow("block height could not be resolved");
      await expect(promise).rejects.toMatchObject({
        kind: "NetworkConfirmationTimeoutError",
        stage: "blockHeight",
      });
    });

    it("throws if /block/<hash> returns 200 but header.metadata.height is missing", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
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

      await expect(connection.waitForConfirmation("at1test")).rejects.toThrow(
        "header.metadata.height is missing or non-numeric",
      );
      await expect(connection.waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "header.metadata.height",
      });
    });

    it("throws if /block/<hash> returns 200 but header.metadata.height is non-numeric", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
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

      await expect(connection.waitForConfirmation("at1test")).rejects.toThrow(
        "header.metadata.height is missing or non-numeric",
      );
      await expect(connection.waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "header.metadata.height",
      });
    });

    it("returns blockHeight 0 when the block JSON explicitly reports height 0 (genesis-adjacent)", async () => {
      const txBody = {
        status: "accepted",
        type: "execute",
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
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
        transitions: [],
      });
    });

    it("parses the block hash whether the find/blockHash body is JSON-quoted or bare", async () => {
      const txBody = {
        status: "accepted",
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
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
        transaction: { type: "execute", id: "at1real", execution: { transitions: [] } },
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
        transitions: [],
      });
    });

    // -----------------------------------------------------------------------
    // ConfirmedTransaction.transitions parsing — accepted, rejected, and
    // malformed bodies. Malformed-after-200 must fail fast (no retry loop).
    // -----------------------------------------------------------------------

    function mockConfirmation(
      txBody: Record<string, unknown>,
      height = 99,
      blockHash = TEST_BLOCK_HASH,
    ) {
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

    it("parses one execute transition with program/function/outputs/tpk into transitions[]", async () => {
      mockConfirmation({
        type: "execute",
        transaction: {
          type: "execute",
          id: "at1test",
          execution: {
            transitions: [
              {
                id: "au1one",
                program: "token.aleo",
                function: "mint_private",
                tpk: "1234group",
                outputs: [{ type: "record", id: "out1", value: "record1plaintextish" }],
              },
            ],
          },
        },
      });

      const result = await createDevnodeConnection().waitForConfirmation("at1test");
      expect(result.transitions).toEqual([
        {
          programId: "token.aleo",
          transitionName: "mint_private",
          rawOutputs: ["record1plaintextish"],
          transitionPublicKey: "1234group",
        },
      ]);
    });

    it("parses multi-transition cross-program calls preserving order", async () => {
      mockConfirmation({
        type: "execute",
        transaction: {
          type: "execute",
          execution: {
            transitions: [
              {
                program: "dex.aleo",
                function: "swap",
                tpk: "tpk_swap",
                outputs: [{ type: "future", id: "f", value: "futurevalue" }],
              },
              {
                program: "token.aleo",
                function: "transfer_private",
                tpk: "tpk_transfer",
                outputs: [{ type: "record", id: "r", value: "record1tokenct" }],
              },
            ],
          },
        },
      });

      const result = await createDevnodeConnection().waitForConfirmation("at1test");
      expect(result.transitions.map((t) => t.transitionName)).toEqual(["swap", "transfer_private"]);
      expect(result.transitions[1]!.rawOutputs).toEqual(["record1tokenct"]);
      expect(result.transitions[1]!.transitionPublicKey).toBe("tpk_transfer");
    });

    it("returns transitions: [] for fee-only rejected tx", async () => {
      mockConfirmation({
        type: "fee",
        transaction: { type: "fee", id: "at1test" },
      });

      const result = await createDevnodeConnection().waitForConfirmation("at1test");
      expect(result.status).toBe("rejected");
      expect(result.transitions).toEqual([]);
    });

    it("fails fast with TransactionShapeParseError on missing program field", async () => {
      mockConfirmation({
        type: "execute",
        transaction: {
          type: "execute",
          execution: {
            transitions: [
              { function: "mint", outputs: [] }, // program missing
            ],
          },
        },
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "transaction.execution.transitions[0].program",
      });
    });

    it("fails fast on missing function field", async () => {
      mockConfirmation({
        type: "execute",
        transaction: {
          type: "execute",
          execution: {
            transitions: [{ program: "token.aleo", outputs: [] }],
          },
        },
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "transaction.execution.transitions[0].function",
      });
    });

    it("fails fast on missing tpk field", async () => {
      mockConfirmation({
        type: "execute",
        transaction: {
          type: "execute",
          execution: {
            transitions: [
              { program: "token.aleo", function: "mint_private", outputs: [] }, // tpk missing
            ],
          },
        },
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "transaction.execution.transitions[0].tpk",
      });
    });

    it("fails fast when transaction.type is execute but execution field is missing", async () => {
      mockConfirmation({
        type: "execute",
        transaction: { type: "execute", id: "at1test" }, // no execution
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "transaction.execution",
      });
    });

    it("fails fast when transaction.type is execute but execution.transitions is missing", async () => {
      mockConfirmation({
        type: "execute",
        transaction: { type: "execute", id: "at1test", execution: {} },
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "transaction.execution.transitions",
      });
    });

    it("fails fast on non-string output.value", async () => {
      mockConfirmation({
        type: "execute",
        transaction: {
          type: "execute",
          execution: {
            transitions: [
              {
                program: "token.aleo",
                function: "mint",
                tpk: "tpk_test",
                outputs: [{ type: "record", id: "x", value: 123 }], // non-string
              },
            ],
          },
        },
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: expect.stringContaining(".outputs[0].value"),
      });
    });

    it("preserves id-only output entries so ABI output positions do not shift", async () => {
      mockConfirmation({
        type: "execute",
        transaction: {
          type: "execute",
          execution: {
            transitions: [
              {
                program: "token_router.aleo",
                function: "demo_transfer",
                tpk: "tpk_router",
                outputs: [
                  { type: "record", id: "intermediate" },
                  { type: "record", id: "returned", value: "record1returned" },
                ],
              },
            ],
          },
        },
      });

      const result = await createDevnodeConnection().waitForConfirmation("at1test");
      expect(result.transitions[0]!.rawOutputs).toEqual([
        { kind: "idOnly", type: "record", id: "intermediate" },
        "record1returned",
      ]);
    });

    it("fails fast on malformed JSON body in 200 OK confirmation (no retry, no timeout masking)", async () => {
      const blockBody = {
        block_hash: TEST_BLOCK_HASH,
        header: { metadata: { network: 1, round: 1, height: 1 } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return {
            ok: true,
            json: async () => {
              throw new SyntaxError("Unexpected token < in JSON at position 0");
            },
          };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: true, text: async () => JSON.stringify(TEST_BLOCK_HASH) };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => blockBody };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "body",
        txId: "at1test",
      });
      // Exactly one /transaction/confirmed/ call — no retry loop.
      const confirmedCalls = fetchMock.mock.calls.filter((c) =>
        (c[0] as string).includes("/transaction/confirmed/"),
      );
      expect(confirmedCalls).toHaveLength(1);
    });

    it("fails fast on malformed JSON body in 200 OK block lookup (Phase 3, unified policy)", async () => {
      // Mirrors the Phase-1 bad-body policy: a 2xx /block/<hash> response whose
      // JSON won't parse is a deterministic shape error that won't self-heal, so
      // it must fail fast rather than retry into a misleading timeout.
      const happyTxBody = {
        type: "execute",
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => happyTxBody };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: true, text: async () => JSON.stringify(TEST_BLOCK_HASH) };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return {
            ok: true,
            json: async () => {
              throw new SyntaxError("Unexpected token < in JSON at position 0");
            },
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        txId: "at1test",
      });
      // Exactly one /block/<hash> call — no retry loop on a deterministic shape error.
      const blockCalls = fetchMock.mock.calls.filter((c) =>
        (c[0] as string).includes(`/block/${TEST_BLOCK_HASH}`),
      );
      expect(blockCalls).toHaveLength(1);
    });

    it("fails fast when the 200 OK confirmation body is valid JSON null (Phase 1)", async () => {
      // A 2xx body of valid JSON `null` must surface as a typed shape error, not
      // a raw TypeError when the orchestrator indexes confirmedBody["transaction"].
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => null };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: true, text: async () => JSON.stringify(TEST_BLOCK_HASH) };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return {
            ok: true,
            json: async () => ({ header: { metadata: { network: 1, round: 1, height: 1 } } }),
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "body",
        txId: "at1test",
      });
      // Exactly one /transaction/confirmed/ call — fail fast, no retry loop.
      const confirmedCalls = fetchMock.mock.calls.filter((c) =>
        (c[0] as string).includes("/transaction/confirmed/"),
      );
      expect(confirmedCalls).toHaveLength(1);
    });

    it("fails fast when the 200 OK block body is valid JSON null (Phase 3)", async () => {
      // A 2xx /block/<hash> body of valid JSON `null` must surface as a typed
      // shape error, not a raw TypeError when the classifier indexes block["header"].
      const happyTxBody = {
        type: "execute",
        transaction: { type: "execute", id: "at1test", execution: { transitions: [] } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => happyTxBody };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: true, text: async () => JSON.stringify(TEST_BLOCK_HASH) };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => null };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      await expect(createDevnodeConnection().waitForConfirmation("at1test")).rejects.toMatchObject({
        kind: "TransactionShapeParseError",
        field: "body",
        txId: "at1test",
      });
      // Exactly one /block/<hash> call — fail fast, no retry loop.
      const blockCalls = fetchMock.mock.calls.filter((c) =>
        (c[0] as string).includes(`/block/${TEST_BLOCK_HASH}`),
      );
      expect(blockCalls).toHaveLength(1);
    });

    it("does retry on transport error from fetch() (regression guard)", async () => {
      // First call throws (transport), second call succeeds — confirms the
      // split-try preserves transient-retry behavior for non-200 paths.
      const blockBody = {
        block_hash: TEST_BLOCK_HASH,
        header: { metadata: { network: 1, round: 1, height: 1 } },
      };
      const happyTxBody = {
        type: "execute",
        transaction: {
          type: "execute",
          id: "at1test",
          execution: { transitions: [] },
        },
      };
      let confirmedCallCount = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          confirmedCallCount += 1;
          if (confirmedCallCount === 1) {
            throw new TypeError("fetch failed");
          }
          return { ok: true, json: async () => happyTxBody };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: true, text: async () => JSON.stringify(TEST_BLOCK_HASH) };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => blockBody };
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const promise = createDevnodeConnection().waitForConfirmation("at1test");
      // Advance past the poll interval so the loop's sleep resolves and the
      // second confirmed-fetch attempt runs.
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;

      expect(result.status).toBe("accepted");
      expect(confirmedCallCount).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // getTransitionOutputs() + execute() awaitConfirmation behavior
  // -------------------------------------------------------------------------

  describe("getTransitionOutputs() / awaitConfirmation", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const TEST_BLOCK_HASH = "ab1blockconfirmoutputs00000000000000000000000000000000000000";

    type Transition = {
      program: string;
      function: string;
      outputs: Array<Record<string, unknown>>;
      tpk?: string;
    };

    function mockConfirmation(
      transitions: readonly Transition[],
      opts: { txId?: string; status?: "accepted" | "rejected"; height?: number } = {},
    ) {
      const txId = opts.txId ?? "at1broadcast";
      const status = opts.status ?? "accepted";
      const height = opts.height ?? 42;
      // Aleo confirms rejected execute transactions as fee-only on inclusion;
      // the chain's parser keys off transaction.type for status, not the outer
      // confirmation envelope's status field.
      const txInner: Record<string, unknown> =
        status === "rejected"
          ? { type: "fee", id: txId }
          : {
              type: "execute",
              id: txId,
              execution: {
                transitions: transitions.map((t) => ({
                  program: t.program,
                  function: t.function,
                  outputs: t.outputs,
                  tpk: t.tpk ?? `tpk_${t.program}_${t.function}`,
                })),
              },
            };
      const txBody: Record<string, unknown> = {
        status,
        type: "execute",
        index: 0,
        finalize: [],
        transaction: txInner,
      };
      const blockBody = {
        block_hash: TEST_BLOCK_HASH,
        header: { metadata: { network: 1, round: height, height } },
      };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/transaction/confirmed/")) {
          return { ok: true, json: async () => txBody };
        }
        if (url.includes("/find/blockHash/")) {
          return { ok: true, text: async () => JSON.stringify(TEST_BLOCK_HASH) };
        }
        if (url.includes(`/block/${TEST_BLOCK_HASH}`)) {
          return { ok: true, json: async () => blockBody };
        }
        throw new Error(`unexpected fetch ${url}`);
      });
    }

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    it("execute() with awaitConfirmation: true returns parsed outputs and rawOutputs", async () => {
      mockConfirmation([
        {
          program: "token.aleo",
          function: "mint_public",
          outputs: [
            { type: "public", value: "100u64" },
            { type: "public", value: "aleo1recipient" },
          ],
        },
      ]);
      const connection = createDevnodeConnection();

      const result = await connection.execute("token.aleo", "mint_public", ["100u64"], {
        awaitConfirmation: true,
      });

      expect(result.txId).toBe("at1broadcast");
      expect(result.outputs).toEqual(["100u64", "aleo1recipient"]);
      expect(result.rawOutputs).toEqual(["100u64", "aleo1recipient"]);
    });

    it("execute() with awaitConfirmation omitted stays fire-and-forget", async () => {
      const connection = createDevnodeConnection();

      const result = await connection.execute("token.aleo", "mint_public", ["100u64"]);

      expect(result.outputs).toEqual([]);
      expect(result.rawOutputs).toBeUndefined();
      expect(result.txId).toBe("at1broadcast");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("execute() with awaitConfirmation: false stays fire-and-forget", async () => {
      const connection = createDevnodeConnection();

      const result = await connection.execute("token.aleo", "mint_public", ["100u64"], {
        awaitConfirmation: false,
      });

      expect(result.outputs).toEqual([]);
      expect(result.rawOutputs).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("execute() with awaitConfirmation: true throws TransitionRejectedError when rejected", async () => {
      mockConfirmation([], { status: "rejected" });
      const connection = createDevnodeConnection();

      await expect(
        connection.execute("token.aleo", "mint_public", ["100u64"], {
          awaitConfirmation: true,
        }),
      ).rejects.toBeInstanceOf(TransitionRejectedError);
    });

    it("getTransitionOutputs() returns outputs for the matching transition", async () => {
      mockConfirmation([
        {
          program: "token.aleo",
          function: "mint_public",
          outputs: [{ type: "public", value: "100u64" }],
        },
      ]);
      const connection = createDevnodeConnection();

      const result = await connection.getTransitionOutputs(
        "at1broadcast",
        "token.aleo",
        "mint_public",
      );

      expect(result.outputs).toEqual(["100u64"]);
      expect(result.rawOutputs).toEqual(["100u64"]);
      expect(result.txId).toBe("at1broadcast");
    });

    it("getTransitionOutputs() throws TransitionSelectionError when no transition matches", async () => {
      mockConfirmation([
        {
          program: "token.aleo",
          function: "approve",
          outputs: [],
        },
      ]);
      const connection = createDevnodeConnection();

      await expect(
        connection.getTransitionOutputs("at1broadcast", "token.aleo", "mint_public"),
      ).rejects.toBeInstanceOf(TransitionSelectionError);
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

      expect(fetchMock).toHaveBeenNthCalledWith(1, "http://127.0.0.1:3030/testnet/block/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ num_blocks: 1 }),
      });
      expect(fetchMock).toHaveBeenNthCalledWith(2, "http://127.0.0.1:3030/testnet/block/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ num_blocks: 1 }),
      });
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
      await expect(connection.getMappingValue("t.aleo", "m", "k")).rejects.toThrow(
        "Connection is closed.",
      );
      await expect(connection.execute("t.aleo", "f", [])).rejects.toThrow("Connection is closed.");
      await expect(connection.waitForConfirmation("at1x")).rejects.toThrow("Connection is closed.");
      await expect(connection.broadcastTransaction("tx")).rejects.toThrow("Connection is closed.");
      await expect(connection.advanceBlocks!(1)).rejects.toThrow("Connection is closed.");
    });

    it("calls account.destroy() on resolved signer accounts", async () => {
      const signerDestroy = vi.fn();
      const signerPm = {
        run: mockRun,
        execute: mockExecute,
        buildDevnodeExecutionTransaction: mockBuildDevnodeExec,
      };
      mockCreateSignerSdkObjects.mockResolvedValue({
        account: { destroy: signerDestroy },
        recordProvider: {},
        programManager: signerPm,
        diagnostics: new SdkDiagnostics(),
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
        diagnostics: new SdkDiagnostics(),
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
        diagnostics: new SdkDiagnostics(),
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

    it("can reuse the same signer PM for local execution after a captured WASM trap", async () => {
      signerRunMock
        .mockImplementationOnce(
          () =>
            new Promise(() => {
              setImmediate(() => {
                throw new WebAssembly.RuntimeError("unreachable");
              });
            }),
        )
        .mockResolvedValueOnce({ getOutputs: () => ["99u32"] });

      const connection = createDevnodeConnection();
      const signer = { privateKey: signerKey, address: signerAddress };

      await expect(
        connection.execute("hello.aleo", "main", ["10u128", "11u128"], {
          mode: "local",
          signer,
        }),
      ).rejects.toThrow(
        "Provable SDK local execution trapped outside the pm.run promise: unreachable",
      );

      const result = await connection.execute("hello.aleo", "main", ["1u32"], {
        mode: "local",
        signer,
      });

      expect(result.outputs).toEqual(["99u32"]);
      expect(mockCreateSignerSdkObjects).toHaveBeenCalledOnce();
      expect(signerRunMock).toHaveBeenCalledTimes(2);
      expect(mockRun).not.toHaveBeenCalled();
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
        egressPolicy: TEST_EGRESS_POLICY,
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
          diagnostics: new SdkDiagnostics(),
        });

      const connection = createDevnodeConnection();
      const signer = { privateKey: signerKey, address: signerAddress };

      // First call fails
      await expect(connection.execute("hello.aleo", "main", ["1u32"], { signer })).rejects.toThrow(
        "WASM init failed",
      );

      // Retry succeeds
      await connection.execute("hello.aleo", "main", ["1u32"], { signer });
      expect(mockCreateSignerSdkObjects).toHaveBeenCalledTimes(2);
      expect(signerBuildDevnodeMock).toHaveBeenCalledOnce();
    });
  });
});
