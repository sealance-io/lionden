/**
 * Runtime behavior tests for the generated BaseContract class.
 *
 * Rather than importing the golden snapshot (which could be stale),
 * this test generates fresh output via generateBaseContract(), transpiles
 * it to JS, writes to a temp .mjs file, and dynamically imports it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { generateBaseContract } from "./typescript-generator.js";

// The dynamically loaded BaseContract class
let BaseContract: any;
let Leo: any;
let LocalRecordDecryptionError: any;
let LocalValueDecryptionError: any;
let RecordDecryptionKeyError: any;
let TransitionInputError: any;
let MappingKeyNotFoundError: any;
let createRecordOutputMatcher: any;
let networkStub: any;
let tmpDir: string;

beforeAll(async () => {
  const source = generateBaseContract();

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: false,
    },
  });

  tmpDir = mkdtempSync(join(tmpdir(), "base-contract-test-"));

  // The generated BaseContract imports decrypt helpers from @lionden/network.
  // Side-load a runtime stub here so the dynamic import resolves; tests that
  // exercise decrypt happy-path mock the stub explicitly.
  const stubPath = join(tmpDir, "network-stub.mjs");
  writeFileSync(stubPath, [
    "export class NetworkRecordDecryptionError extends Error {",
    "  constructor(message, ciphertextPrefix, cause) {",
    "    super(message, cause === undefined ? undefined : { cause });",
    "    this.name = 'NetworkRecordDecryptionError';",
    "    this.kind = 'NetworkRecordDecryptionError';",
    "    this.ciphertextPrefix = ciphertextPrefix;",
    "  }",
    "}",
    "export class NetworkValueDecryptionError extends Error {",
    "  constructor(message, ciphertextPrefix, cause) {",
    "    super(message, cause === undefined ? undefined : { cause });",
    "    this.name = 'NetworkValueDecryptionError';",
    "    this.kind = 'NetworkValueDecryptionError';",
    "    this.ciphertextPrefix = ciphertextPrefix;",
    "  }",
    "}",
    "export let decryptRecordCiphertext = async () => { throw new NetworkRecordDecryptionError('stub', ''); };",
    "export let decryptValueCiphertext = async () => { throw new NetworkValueDecryptionError('stub', ''); };",
    "export let deriveViewKey = async () => { throw new NetworkRecordDecryptionError('stub deriveViewKey', ''); };",
    "export function __setDecryptStubs(stubs) {",
    "  if (stubs.decryptRecordCiphertext) decryptRecordCiphertext = stubs.decryptRecordCiphertext;",
    "  if (stubs.decryptValueCiphertext) decryptValueCiphertext = stubs.decryptValueCiphertext;",
    "  if (stubs.deriveViewKey) deriveViewKey = stubs.deriveViewKey;",
    "}",
  ].join("\n"));

  const outPath = join(tmpDir, "BaseContract.mjs");
  // Rewrite the bare-specifier import so Node can resolve it relative to tmpDir.
  const rewritten = transpiled.outputText.replace(
    /from\s+["']@lionden\/network["']/g,
    `from "./network-stub.mjs"`,
  );
  writeFileSync(outPath, rewritten);

  const mod = await import(outPath);
  BaseContract = mod.BaseContract;
  Leo = mod.Leo;
  LocalRecordDecryptionError = mod.LocalRecordDecryptionError;
  LocalValueDecryptionError = mod.LocalValueDecryptionError;
  RecordDecryptionKeyError = mod.RecordDecryptionKeyError;
  TransitionInputError = mod.TransitionInputError;
  MappingKeyNotFoundError = mod.MappingKeyNotFoundError;
  createRecordOutputMatcher = mod.createRecordOutputMatcher;

  // Import the stub module separately so tests can swap the decryption
  // helper implementations via __setDecryptStubs (ESM live bindings).
  networkStub = await import(stubPath);
});

afterAll(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** Create a concrete subclass to access protected methods. */
function createTestContract(
  programId = "test.aleo",
  options?: { imports?: readonly string[] },
) {
  class TestContract extends BaseContract {
    constructor(id = programId, ctorOpts: { imports?: readonly string[] } | undefined = options) {
      super(id, ctorOpts);
    }
    // Expose protected methods for testing
    async testExecuteLocal(...args: any[]) {
      return this.executeLocal(...args);
    }
    async testExpectLocalFailure(...args: any[]) {
      return this.expectLocalFailure(...args);
    }
    async testSubmit(...args: any[]) {
      return this.submitTransition(...args);
    }
    async testSettle(...args: any[]) {
      return this.settleTransition(...args);
    }
    async testAccepted(...args: any[]) {
      return this.expectAccepted(...args);
    }
    async testRejected(...args: any[]) {
      return this.expectRejected(...args);
    }
    async testSettleTyped(...args: any[]) {
      return (this as any).settleTyped(...args);
    }
    async testExpectAcceptedTyped(...args: any[]) {
      return (this as any).expectAcceptedTyped(...args);
    }
    async testQueryMapping(...args: any[]) {
      return this.queryMapping(...args);
    }
    async testMappingContains(...args: any[]) {
      return this.mappingContains(...args);
    }
    async testRequireMappingRaw(...args: any[]) {
      return this.requireMappingRaw(...args);
    }
  }
  return new TestContract(programId);
}

function mockLre(networkOverrides: Record<string, any> = {}) {
  return {
    network: {
      execute: async () => ({ outputs: ["42u32"], txId: "at1mock" }),
      getMappingValue: async () => "100u64",
      ...networkOverrides,
    },
  } as any;
}

// ---------------------------------------------------------------------------
// connect / getLre
// ---------------------------------------------------------------------------

describe("BaseContract runtime", () => {
  describe("connect / getLre", () => {
    it("throws when execution is called without connect()", async () => {
      const contract = createTestContract();

      await expect(
        contract.testExecuteLocal("main", ["1u32"]),
      ).rejects.toThrow("Contract test.aleo is not connected to an LRE");
    });

    it("connect() returns this for chaining", () => {
      const contract = createTestContract();
      const result = contract.connect(mockLre());

      expect(result).toBe(contract);
    });
  });

  // -------------------------------------------------------------------------
  // executeLocal / submitTransition
  // -------------------------------------------------------------------------

  describe("executeLocal()", () => {
    it("delegates to lre.network.execute with programId", async () => {
      const executeMock = async (
        programId: string,
        transitionName: string,
        args: string[],
        options: any,
      ) => {
        return { outputs: ["8u32"], txId: "at1test" };
      };
      const spy = { calls: [] as any[] };
      const wrappedExecute = async (...args: any[]) => {
        spy.calls.push(args);
        return executeMock(...(args as [string, string, string[], any]));
      };

      const contract = createTestContract("hello.aleo");
      contract.connect(mockLre({ execute: wrappedExecute }));

      const result = await contract.testExecuteLocal("main", ["3u32", "5u32"], { fee: 100 });

      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toEqual([
        "hello.aleo",
        "main",
        ["3u32", "5u32"],
        { fee: 100, mode: "local" },
      ]);
      expect(result.outputs).toEqual(["8u32"]);
    });

    it("throws when lre.network is missing", async () => {
      const contract = createTestContract();
      contract.connect({ network: null } as any);

      await expect(
        contract.testExecuteLocal("main", []),
      ).rejects.toThrow("Network is not available for test.aleo");
    });

    it("throws when lre.network.execute is not a function", async () => {
      const contract = createTestContract();
      contract.connect({ network: { execute: "not-a-fn" } } as any);

      await expect(
        contract.testExecuteLocal("main", []),
      ).rejects.toThrow("Network is not available for test.aleo");
    });

    it("passes mode: 'local' merged with other options", async () => {
      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: undefined };
          },
        }),
      );

      await contract.testExecuteLocal("main", ["1u32"], { fee: 200 });

      expect(spy.calls[0]![3]).toEqual({ fee: 200, mode: "local" });
    });
  });

  describe("expectLocalFailure()", () => {
    it("captures local execution failures as structured errors", async () => {
      const sdkError = new Error("assertion failed");
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async () => {
            throw sdkError;
          },
        }),
      );

      const error = await contract.testExpectLocalFailure("main", ["1u32"]);

      expect(error).toMatchObject({
        kind: "LocalTransitionError",
        phase: "local",
        programId: "hello.aleo",
        transition: "main",
      });
      expect(error.cause).toBe(sdkError);
      expect(error.message).toContain("hello.aleo/main failed during local execution");
    });

    it("throws UnexpectedLocalSuccessError when the transition succeeds", async () => {
      const contract = createTestContract("hello.aleo");
      contract.connect(mockLre({ execute: async () => ({ outputs: ["1u32"] }) }));

      await expect(
        contract.testExpectLocalFailure("main", ["1u32"]),
      ).rejects.toMatchObject({
        kind: "UnexpectedLocalSuccessError",
        phase: "local",
        programId: "hello.aleo",
        transition: "main",
      });
    });
  });

  describe("submitTransition()", () => {
    it("passes mode: 'onchain' merged with other options", async () => {
      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: "at1tx" };
          },
        }),
      );

      await contract.testSubmit("transfer", ["aleo1abc", "100u64"], { fee: 50 });

      expect(spy.calls[0]![3]).toEqual({ fee: 50, mode: "onchain" });
    });

    it("throws when result has no txId", async () => {
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: ["1u32"], txId: undefined }),
        }),
      );

      await expect(
        contract.testSubmit("main", []),
      ).rejects.toThrow("hello.aleo/main was submitted on-chain but no transaction ID was returned");
    });

    it("returns result when txId is present", async () => {
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: ["42u32"], txId: "at1ok" }),
        }),
      );

      const result = await contract.testSubmit("main", []);

      expect(result.txId).toBe("at1ok");
    });
  });

  describe("settled transition helpers", () => {
    it("settles accepted transactions", async () => {
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "at1ok" }),
          waitForConfirmation: async () => ({
            txId: "at1ok",
            blockHeight: 12,
            status: "accepted",
            transitions: [{ programId: "hello.aleo", transitionName: "main", rawOutputs: [], transitionPublicKey: "tpk_test_main" }],
          }),
        }),
      );

      await expect(contract.testAccepted("main", [])).resolves.toEqual({
        txId: "at1ok",
        blockHeight: 12,
        status: "accepted",
        rawOutputs: [],
        transitionPublicKey: "tpk_test_main",
        transitions: [
          { programId: "hello.aleo", transitionName: "main", rawOutputs: [], transitionPublicKey: "tpk_test_main" },
        ],
      });
    });

    it("distinguishes on-chain rejection from local failure", async () => {
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "at1bad" }),
          waitForConfirmation: async () => ({
            txId: "at1bad",
            blockHeight: 13,
            status: "rejected",
            transitions: [],
          }),
        }),
      );

      await expect(
        contract.testAccepted("main", []),
      ).rejects.toThrow("confirmed rejected");
      await expect(
        contract.testRejected("main", []),
      ).resolves.toMatchObject({ txId: "at1bad", status: "rejected" });
    });

    it("wraps typed network confirmation timeouts without string matching", async () => {
      const timeout = Object.assign(
        new Error("custom timeout wording"),
        { name: "NetworkConfirmationTimeoutError", kind: "NetworkConfirmationTimeoutError" },
      );
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "at1slow" }),
          waitForConfirmation: async () => {
            throw timeout;
          },
        }),
      );

      await expect(
        contract.testSettle("main", []),
      ).rejects.toMatchObject({
        kind: "TransactionConfirmationTimeoutError",
        phase: "confirm",
        programId: "hello.aleo",
        transition: "main",
        cause: timeout,
      });
    });

    it("throws TransactionShapeError for malformed confirmation responses", async () => {
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "at1badshape" }),
          waitForConfirmation: async () => ({
            txId: "different",
            blockHeight: "12",
            status: "pending",
            transitions: [],
          }),
        }),
      );

      await expect(
        contract.testSettle("main", []),
      ).rejects.toMatchObject({
        kind: "TransactionShapeError",
        phase: "shape",
        programId: "hello.aleo",
        transition: "main",
      });
    });
  });

  // -------------------------------------------------------------------------
  // LIONDEN_PROVE injection
  // -------------------------------------------------------------------------

  describe("LIONDEN_PROVE injection", () => {
    afterEach(() => {
      delete process.env["LIONDEN_PROVE"];
    });

    it("injects prove: true when LIONDEN_PROVE=true and caller didn't specify", async () => {
      process.env["LIONDEN_PROVE"] = "true";

      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: "at1ok" };
          },
        }),
      );

      await contract.testSubmit("main", ["1u32"], { fee: 100 });

      expect(spy.calls[0]![3]).toEqual({ fee: 100, mode: "onchain", prove: true });
    });

    it("does not inject prove when LIONDEN_PROVE is unset", async () => {
      delete process.env["LIONDEN_PROVE"];

      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: "at1ok" };
          },
        }),
      );

      await contract.testSubmit("main", ["1u32"], { fee: 100 });

      expect(spy.calls[0]![3]).toEqual({ fee: 100, mode: "onchain" });
      expect(spy.calls[0]![3].prove).toBeUndefined();
    });

    it("respects an explicit prove: false even when LIONDEN_PROVE=true", async () => {
      process.env["LIONDEN_PROVE"] = "true";

      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: "at1ok" };
          },
        }),
      );

      await contract.testSubmit("main", ["1u32"], { fee: 100, prove: false });

      expect(spy.calls[0]![3]).toEqual({ fee: 100, mode: "onchain", prove: false });
    });

    it("does not inject prove when LIONDEN_PROVE is set to a non-'true' value", async () => {
      process.env["LIONDEN_PROVE"] = "1"; // truthy string but not "true"

      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: "at1ok" };
          },
        }),
      );

      await contract.testSubmit("main", []);

      expect(spy.calls[0]![3].prove).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // queryMapping
  // -------------------------------------------------------------------------

  describe("queryMapping()", () => {
    it("delegates to lre.network.getMappingValue with programId", async () => {
      const spy = { calls: [] as any[] };
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          getMappingValue: async (...args: any[]) => {
            spy.calls.push(args);
            return "500u64";
          },
        }),
      );

      const value = await contract.testQueryMapping("balances", "aleo1abc");

      expect(spy.calls[0]).toEqual(["token.aleo", "balances", "aleo1abc"]);
      expect(value).toBe("500u64");
    });

    it("throws when network is missing", async () => {
      const contract = createTestContract();
      contract.connect({ network: null } as any);

      await expect(
        contract.testQueryMapping("balances", "aleo1abc"),
      ).rejects.toThrow("Network is not available for test.aleo");
    });

    it("throws when getMappingValue is not a function", async () => {
      const contract = createTestContract();
      contract.connect({ network: { getMappingValue: 42 } } as any);

      await expect(
        contract.testQueryMapping("balances", "aleo1abc"),
      ).rejects.toThrow("Network is not available for test.aleo");
    });
  });

  describe("mappingContains()", () => {
    it("returns true when the key resolves to a value", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(mockLre({ getMappingValue: async () => "500u64" }));

      expect(await contract.testMappingContains("balances", "aleo1abc")).toBe(true);
    });

    it("returns false when the key is absent (null)", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(mockLre({ getMappingValue: async () => null }));

      expect(await contract.testMappingContains("balances", "aleo1abc")).toBe(false);
    });
  });

  describe("requireMappingRaw()", () => {
    it("returns the raw value when the key is present", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(mockLre({ getMappingValue: async () => "500u64" }));

      expect(await contract.testRequireMappingRaw("balances", "aleo1abc")).toBe("500u64");
    });

    it("throws MappingKeyNotFoundError when the key is absent", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(mockLre({ getMappingValue: async () => null }));

      let thrown: any;
      try {
        await contract.testRequireMappingRaw("balances", "aleo1abc");
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(MappingKeyNotFoundError);
      expect(thrown.kind).toBe("MappingKeyNotFoundError");
      expect(thrown.phase).toBe("mapping");
      expect(thrown.programId).toBe("token.aleo");
      expect(thrown.mapping).toBe("balances");
      expect(thrown.key).toBe("aleo1abc");
      expect(thrown.message).toContain("token.aleo");
      expect(thrown.message).toContain("balances");
      expect(thrown.message).toContain("aleo1abc");
    });
  });

  // -------------------------------------------------------------------------
  // withSigner()
  // -------------------------------------------------------------------------

  describe("withSigner()", () => {
    const signer1 = { privateKey: "key1", address: "aleo1signer1" };
    const signer2 = { privateKey: "key2", address: "aleo1signer2" };

    it("returns a new instance that does not mutate the original", () => {
      const original = createTestContract("hello.aleo");
      original.connect(mockLre());

      const withSig = original.withSigner(signer1);

      expect(withSig).not.toBe(original);
      expect((withSig as any).signer).toEqual(signer1);
      expect((original as any).signer).toBeUndefined();
    });

    it("preserves LRE connection on the cloned instance", async () => {
      const executeSpy = vi.fn().mockResolvedValue({ outputs: [], txId: "at1ok" });
      const contract = createTestContract("hello.aleo");
      contract.connect(mockLre({ execute: executeSpy }));

      const withSig = contract.withSigner(signer1);
      await withSig.testSubmit("main", ["1u32"]);

      expect(executeSpy).toHaveBeenCalledOnce();
    });

    it("merges instance signer as default in local execution", async () => {
      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: "at1ok" };
          },
        }),
      );

      const withSig = contract.withSigner(signer1);
      await withSig.testExecuteLocal("main", ["1u32"], { fee: 100 });

      expect(spy.calls[0]![3]).toEqual({ fee: 100, mode: "local", signer: signer1 });
    });

    it("per-call signer overrides instance signer", async () => {
      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: "at1ok" };
          },
        }),
      );

      const withSig = contract.withSigner(signer1);
      await withSig.testExecuteLocal("main", ["1u32"], { signer: signer2 });

      // Per-call signer2 should win
      expect(spy.calls[0]![3].signer).toEqual(signer2);
    });

    it("does not inject signer when no instance signer is set", async () => {
      const spy = { calls: [] as any[] };
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async (...args: any[]) => {
            spy.calls.push(args);
            return { outputs: [], txId: "at1ok" };
          },
        }),
      );

      await contract.testExecuteLocal("main", ["1u32"], { fee: 50 });

      expect(spy.calls[0]![3]).toEqual({ fee: 50, mode: "local" });
      expect(spy.calls[0]![3].signer).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Static parsers
  // -------------------------------------------------------------------------

  describe("static parsers", () => {
    describe("stripSuffix", () => {
      it.each([
        ["100u8", "100"],
        ["200u16", "200"],
        ["300u32", "300"],
        ["400u64", "400"],
        ["500u128", "500"],
        ["-1i8", "-1"],
        ["-2i16", "-2"],
        ["-3i32", "-3"],
        ["-4i64", "-4"],
        ["-5i128", "-5"],
        ["123field", "123"],
        ["456group", "456"],
        ["789scalar", "789"],
        ["truebool", "true"],
        ["aleo1abcaddress", "aleo1abc"],
        // Visibility suffixes (SDK record fields)
        ["2u64.private", "2"],
        ["100u128.public", "100"],
        ["aleo1abcaddress.private", "aleo1abc"],
      ])("strips suffix from %s → %s", (input, expected) => {
        expect(BaseContract.stripSuffix(input)).toBe(expected);
      });

      it("does not strip non-dot visibility-like suffixes", () => {
        // "xprivate" should NOT be treated as a visibility suffix
        expect(BaseContract.stripSuffix("2u64xprivate")).toBe("2u64xprivate");
      });
    });

    describe("parseBoolean", () => {
      it("parses 'true' to true", () => {
        expect(BaseContract.parseBoolean("true")).toBe(true);
      });

      it("parses 'false' to false", () => {
        expect(BaseContract.parseBoolean("false")).toBe(false);
      });

      it("strips a .private visibility suffix", () => {
        expect(BaseContract.parseBoolean("true.private")).toBe(true);
        expect(BaseContract.parseBoolean("false.private")).toBe(false);
      });

      it("strips a .public visibility suffix", () => {
        expect(BaseContract.parseBoolean("true.public")).toBe(true);
        expect(BaseContract.parseBoolean("false.public")).toBe(false);
      });
    });

    describe("parseString", () => {
      it("returns plain values unchanged", () => {
        expect(BaseContract.parseString("aleo1abc")).toBe("aleo1abc");
        expect(BaseContract.parseString("0field")).toBe("0field");
      });

      it("strips a .private visibility suffix from record-field values", () => {
        expect(BaseContract.parseString("aleo1abc.private")).toBe("aleo1abc");
        expect(BaseContract.parseString("0field.private")).toBe("0field");
      });

      it("strips a .public visibility suffix from record-field values", () => {
        expect(BaseContract.parseString("aleo1abc.public")).toBe("aleo1abc");
      });
    });

    describe("parseNumber", () => {
      it("parses '42u32' to 42", () => {
        expect(BaseContract.parseNumber("42u32")).toBe(42);
      });

      it("parses '-7i32' to -7", () => {
        expect(BaseContract.parseNumber("-7i32")).toBe(-7);
      });
    });

    describe("parseBigInt", () => {
      it("parses '100u64' to 100n", () => {
        expect(BaseContract.parseBigInt("100u64")).toBe(100n);
      });

      it("parses '999999999999u128' to bigint", () => {
        expect(BaseContract.parseBigInt("999999999999u128")).toBe(999999999999n);
      });
    });

    describe("branded Leo constructors", () => {
      it("validates and normalizes primitive Leo literals", () => {
        expect(Leo.address({ address: "aleo1qqqq" })).toBe("aleo1qqqq");
        expect(Leo.field("12field")).toBe("12field");
        expect(Leo.group("7group")).toBe("7group");
        expect(Leo.scalar("9scalar")).toBe("9scalar");
        expect(Leo.identifier("'strategy_one'")).toBe("strategy_one");
      });

      it("rejects invalid primitive Leo literals early", () => {
        expect(() => Leo.address("not-an-address")).toThrow("expected Address");
        expect(() => Leo.field("12")).toThrow("expected Field literal");
        expect(() => Leo.group("7")).toThrow("expected Group literal");
        expect(() => Leo.scalar("9")).toThrow("expected Scalar literal");
        expect(() => Leo.identifier("1strategy")).toThrow("expected Identifier matching");
      });
    });

    describe("integer serializers", () => {
      it("serializes integer values at their valid bounds", () => {
        expect(BaseContract.serializeUInt(255, 8)).toBe("255u8");
        expect(BaseContract.serializeUInt((1n << 64n) - 1n, 64)).toBe("18446744073709551615u64");
        expect(BaseContract.serializeInt(-128, 8)).toBe("-128i8");
        expect(BaseContract.serializeInt(127, 8)).toBe("127i8");
        expect(BaseContract.serializeInt(-(1n << 63n), 64)).toBe("-9223372036854775808i64");
      });

      it("rejects out-of-range and wrong-shaped integers", () => {
        expect(() => BaseContract.serializeUInt(-1, 8)).toThrow("expected u8 in range 0..255");
        expect(() => BaseContract.serializeUInt(256, 8)).toThrow("expected u8 in range 0..255");
        expect(() => BaseContract.serializeUInt(1n, 32)).toThrow("expected u32 number");
        expect(() => BaseContract.serializeUInt(1, 64)).toThrow("expected u64 bigint");
        expect(() => BaseContract.serializeInt(-129, 8)).toThrow("expected i8 in range -128..127");
        expect(() => BaseContract.serializeInt(128, 8)).toThrow("expected i8 in range -128..127");
        expect(() => BaseContract.serializeInt(1, 64)).toThrow("expected i64 bigint");
      });
    });

    describe("input validation errors", () => {
      it("carries structured context for invalid primitive input", () => {
        expect(() =>
          BaseContract.serializeAddress("bad", {
            programId: "token.aleo",
            transition: "transfer",
            input: "receiver",
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[TransitionInputError: token.aleo/transfer input "receiver" expected Address. Received string "bad". Use Leo.address(...) or pass a named/devnode account.]`,
        );

        try {
          BaseContract.serializeAddress("bad", {
            programId: "token.aleo",
            transition: "transfer",
            input: "receiver",
          });
        } catch (error) {
          expect(error).toMatchObject({
            kind: "TransitionInputError",
            phase: "input",
            programId: "token.aleo",
            transition: "transfer",
            input: "receiver",
          });
        }
      });

      it("reports nested array paths for recursive input validation", () => {
        expect(() =>
          BaseContract.serializeArray(
            [[1, "bad"]],
            { programId: "matrix.aleo", transition: "set", input: "values" },
            (row: unknown, rowContext: any) =>
              BaseContract.serializeArray(
                row,
                rowContext,
                (cell: unknown, cellContext: any) => BaseContract.serializeUInt(cell, 8, cellContext),
              ),
          ),
        ).toThrow('matrix.aleo/set input "values".0.1 expected u8 number');
      });

      it("fails fast for Optional None values that have no generated zero value", () => {
        expect(() =>
          BaseContract.serializeUnsupportedOptionalNone({
            programId: "settings.aleo",
            transition: "update",
            input: "metadata",
          }),
        ).toThrow("non-null Optional value");
      });
    });

    describe("identifier helpers", () => {
      it("serializes bare identifiers as single-quoted Leo literals", () => {
        expect(BaseContract.serializeIdentifier("voting_power")).toBe("'voting_power'");
      });

      it("preserves already quoted identifier literals", () => {
        expect(BaseContract.serializeIdentifier(" 'voting_power' ")).toBe("'voting_power'");
      });

      it("rejects empty identifier values", () => {
        expect(() => BaseContract.serializeIdentifier("   ")).toThrow("expected Identifier");
      });

      it("rejects one-sided quoted identifier values", () => {
        expect(() => BaseContract.serializeIdentifier("'voting_power")).toThrow("expected Identifier matching");
      });

      it("rejects identifier values with embedded quotes", () => {
        expect(() => BaseContract.serializeIdentifier("voting'power")).toThrow("expected Identifier matching");
      });

      it("rejects identifier values that do not start with a letter or underscore", () => {
        expect(() => BaseContract.serializeIdentifier("1strategy")).toThrow("expected Identifier matching");
      });

      it("parses quoted identifier literals to bare names", () => {
        expect(BaseContract.parseIdentifier("'voting_power'")).toBe("voting_power");
      });

      it("trims bare identifier values", () => {
        expect(BaseContract.parseIdentifier(" voting_power ")).toBe("voting_power");
      });

      it("strips a .private visibility suffix from record-field identifiers", () => {
        expect(BaseContract.parseIdentifier("'voting_power'.private")).toBe("voting_power");
      });

      it("strips a .public visibility suffix from record-field identifiers", () => {
        expect(BaseContract.parseIdentifier("'voting_power'.public")).toBe("voting_power");
      });
    });

    describe("parseArray", () => {
      it("parses simple elements", () => {
        const result = BaseContract.parseArray("[1u32, 2u32, 3u32]");
        expect(result).toEqual(["1u32", "2u32", "3u32"]);
      });

      it("handles nested structs with commas (depth-aware)", () => {
        const result = BaseContract.parseArray("[{a: 1, b: 2}, {a: 3, b: 4}]");
        expect(result).toEqual(["{a: 1, b: 2}", "{a: 3, b: 4}"]);
      });

      it("returns empty array for empty input", () => {
        expect(BaseContract.parseArray("[]")).toEqual([]);
      });

      it("handles nested arrays", () => {
        const result = BaseContract.parseArray("[[1, 2], [3, 4]]");
        expect(result).toEqual(["[1, 2]", "[3, 4]"]);
      });
    });

    describe("parseStruct", () => {
      it("parses flat fields", () => {
        const result = BaseContract.parseStruct("{ x: 1u32, y: 2u64 }");
        expect(result).toEqual({ x: "1u32", y: "2u64" });
      });

      it("preserves nested struct values", () => {
        const result = BaseContract.parseStruct(
          "{ owner: aleo1abc, metadata: { id: 1u64, name: test } }",
        );
        expect(result).toEqual({
          owner: "aleo1abc",
          metadata: "{ id: 1u64, name: test }",
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Leo.dynamicRecord — typed dyn record encoder
  // -------------------------------------------------------------------------

  describe("Leo.dynamicRecord", () => {
    const ADDR = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

    it("composes a dyn record with mixed-visibility primitives", () => {
      const dyn = Leo.dynamicRecord(
        { owner: Leo.address(ADDR), amount: 100n, _nonce: Leo.group("0group"), _version: 0 },
        {
          owner: "address.private",
          amount: "u128.private",
          _nonce: "group.public",
          _version: "u8.public",
        },
      );
      expect(dyn).toBe(
        `{ owner: ${ADDR}.private, amount: 100u128.private, _nonce: 0group.public, _version: 0u8.public }`,
      );
    });

    it("throws when value has missing keys vs schema", () => {
      expect(() =>
        Leo.dynamicRecord(
          { owner: Leo.address(ADDR) },
          { owner: "address.private", amount: "u128.private" },
        ),
      ).toThrow(/Missing in value: \[amount\]/);
    });

    it("throws when value has extra keys vs schema", () => {
      expect(() =>
        Leo.dynamicRecord(
          { owner: Leo.address(ADDR), surprise: 1 },
          { owner: "address.private" },
        ),
      ).toThrow(/Extra in value: \[surprise\]/);
    });

    it("throws on malformed schema entry (missing visibility)", () => {
      expect(() =>
        Leo.dynamicRecord(
          { x: 1 },
          { x: "u8" } as any,
        ),
      ).toThrow(/must be "<type>\.<visibility>"/);
    });

    it("throws on invalid visibility", () => {
      expect(() =>
        Leo.dynamicRecord(
          { x: 1 },
          { x: "u8.weird" } as any,
        ),
      ).toThrow(/invalid visibility "weird"/);
    });

    it("range-checks integer values per bit width", () => {
      expect(() =>
        Leo.dynamicRecord(
          { x: 300 },
          { x: "u8.public" },
        ),
      ).toThrow(/u8 in range 0\.\.255/);
    });

    it("rejects non-object value", () => {
      expect(() => Leo.dynamicRecord("not an object" as any, {})).toThrow(
        /expected an object value/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // RecordDecryptionKey normalization + decryptRecord error wrapping
  // -------------------------------------------------------------------------

  describe("BaseContract.decryptRecord", () => {
    it("throws RecordDecryptionKeyError on unrecognized string prefix", async () => {
      await expect(
        BaseContract.decryptRecord("record1abc", "deadbeef", (s: string) => s),
      ).rejects.toMatchObject({
        kind: "RecordDecryptionKeyError",
        message: expect.stringContaining('"deadbeef"'),
      });
    });

    it("throws RecordDecryptionKeyError on null key", async () => {
      await expect(
        BaseContract.decryptRecord("record1abc", null as any, (s: string) => s),
      ).rejects.toMatchObject({
        kind: "RecordDecryptionKeyError",
      });
    });

    it("throws RecordDecryptionKeyError on object without viewKey/privateKey", async () => {
      await expect(
        BaseContract.decryptRecord("record1abc", { other: "x" } as any, (s: string) => s),
      ).rejects.toMatchObject({
        kind: "RecordDecryptionKeyError",
      });
    });

    it("wraps SDK decrypt errors as LocalRecordDecryptionError", async () => {
      // The stub at the top of this file throws NetworkRecordDecryptionError;
      // BaseContract.decryptRecord must re-wrap as LocalRecordDecryptionError.
      await expect(
        BaseContract.decryptRecord(
          "record1abc",
          { viewKey: "AViewKey1zz" },
          (s: string) => s,
        ),
      ).rejects.toMatchObject({
        kind: "LocalRecordDecryptionError",
      });
    });

    it("wraps deriveViewKey failures (bad APrivateKey1 input) as LocalRecordDecryptionError", async () => {
      // Bad-prefix strings throw RecordDecryptionKeyError (input layer).
      // A WELL-FORMED-prefix string that the SDK rejects mid-derivation should
      // emerge as LocalRecordDecryptionError — not raw NetworkRecordDecryptionError.
      const restore = networkStub.deriveViewKey;
      try {
        networkStub.__setDecryptStubs({
          deriveViewKey: async () => {
            throw new networkStub.NetworkRecordDecryptionError("sdk rejected pk", "");
          },
        });
        await expect(
          BaseContract.decryptRecord("record1abc", "APrivateKey1bogus", (s: string) => s),
        ).rejects.toMatchObject({
          kind: "LocalRecordDecryptionError",
        });
      } finally {
        networkStub.__setDecryptStubs({ deriveViewKey: restore });
      }
    });

    it("rejects {viewKey: 'bad'} at the input layer (RecordDecryptionKeyError, not LocalRecordDecryptionError)", async () => {
      await expect(
        BaseContract.decryptRecord(
          "record1abc",
          { viewKey: "deadbeef" },
          (s: string) => s,
        ),
      ).rejects.toMatchObject({
        kind: "RecordDecryptionKeyError",
        message: expect.stringContaining("AViewKey1"),
      });
    });

    it("rejects {privateKey: 'bad'} at the input layer (RecordDecryptionKeyError)", async () => {
      await expect(
        BaseContract.decryptRecord(
          "record1abc",
          { privateKey: "not-a-pk" },
          (s: string) => s,
        ),
      ).rejects.toMatchObject({
        kind: "RecordDecryptionKeyError",
        message: expect.stringContaining("APrivateKey1"),
      });
    });

    it("returns the deserialized record on successful decrypt", async () => {
      const plaintext = "{ owner: aleo1abc.private, amount: 100u64.private, _nonce: 0group.public }";
      const restore = networkStub.decryptRecordCiphertext;
      try {
        networkStub.__setDecryptStubs({
          decryptRecordCiphertext: async () => plaintext,
        });
        const stubDeserialize = (s: string) => ({ kind: "Token", raw: s });
        const result = await BaseContract.decryptRecord(
          "record1abc",
          { viewKey: "AViewKey1xyz" },
          stubDeserialize,
        );
        expect(result).toEqual({ kind: "Token", raw: plaintext });
      } finally {
        networkStub.__setDecryptStubs({ decryptRecordCiphertext: restore });
      }
    });

    it("preserves RECORD_RAW cache so the decrypted record round-trips through serialize", async () => {
      // Drive the realistic codegen-emitted deserializer pattern: parseStruct
      // then Object.defineProperty(_record, BaseContract.RECORD_RAW, ...).
      const plaintext = "{ owner: aleo1abc.private, amount: 100u64.private, _nonce: 0group.public }";
      const restore = networkStub.decryptRecordCiphertext;
      try {
        networkStub.__setDecryptStubs({
          decryptRecordCiphertext: async () => plaintext,
        });
        // Mimic what generated deserialize<Name> does.
        const deserialize = (value: string) => {
          const fields = BaseContract.parseStruct(value);
          const record: Record<string, unknown> = {
            owner: BaseContract.parseAddress(fields.owner),
            amount: BigInt(BaseContract.stripSuffix(fields.amount)),
            _nonce: BaseContract.parseGroup(fields._nonce),
          };
          Object.defineProperty(record, BaseContract.RECORD_RAW, {
            value,
            enumerable: false,
          });
          return record;
        };

        const decrypted = await BaseContract.decryptRecord(
          "record1abc",
          { viewKey: "AViewKey1xyz" },
          deserialize,
        );

        // RECORD_RAW symbol survives the decrypt → deserialize boundary so that
        // a subsequent transition can re-serialize the record verbatim and
        // avoid the visibility-suffix mangling problem.
        expect((decrypted as Record<symbol, unknown>)[BaseContract.RECORD_RAW]).toBe(plaintext);
      } finally {
        networkStub.__setDecryptStubs({ decryptRecordCiphertext: restore });
      }
    });
  });

  // -------------------------------------------------------------------------
  // selectTransitionOutputs — fail-fast transition-identity filter
  // -------------------------------------------------------------------------

  describe("settleTransition transition-identity filter", () => {
    it("populates rawOutputs from the matching transition on accepted", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "at1ok" }),
          waitForConfirmation: async () => ({
            txId: "at1ok",
            blockHeight: 5,
            status: "accepted",
            transitions: [
              { programId: "credits.aleo", transitionName: "fee_public", rawOutputs: [], transitionPublicKey: "tpk_test_fee" },
              { programId: "token.aleo", transitionName: "mint", rawOutputs: ["record1xyz"], transitionPublicKey: "tpk_test_mint" },
            ],
          }),
        }),
      );

      await expect(contract.testAccepted("mint", [])).resolves.toMatchObject({
        rawOutputs: ["record1xyz"],
      });
    });

    it("throws TransactionShapeError on 0 matches when accepted", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "at1nope" }),
          waitForConfirmation: async () => ({
            txId: "at1nope",
            blockHeight: 5,
            status: "accepted",
            transitions: [
              { programId: "credits.aleo", transitionName: "fee_public", rawOutputs: [], transitionPublicKey: "tpk_test_fee" },
            ],
          }),
        }),
      );

      await expect(contract.testAccepted("mint", [])).rejects.toMatchObject({
        kind: "TransactionShapeError",
        message: expect.stringContaining("did not contain a matching transition for token.aleo/mint"),
      });
    });

    it("throws TransactionShapeError on >1 matches when accepted", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "at1dup" }),
          waitForConfirmation: async () => ({
            txId: "at1dup",
            blockHeight: 5,
            status: "accepted",
            transitions: [
              { programId: "token.aleo", transitionName: "mint", rawOutputs: ["a"], transitionPublicKey: "tpk_test_a" },
              { programId: "token.aleo", transitionName: "mint", rawOutputs: ["b"], transitionPublicKey: "tpk_test_b" },
            ],
          }),
        }),
      );

      await expect(contract.testAccepted("mint", [])).rejects.toMatchObject({
        kind: "TransactionShapeError",
        message: expect.stringContaining("contained 2 transitions matching"),
      });
    });

    it("returns rawOutputs: [] on rejected with no matching transition (fee-only inclusion)", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "at1rej" }),
          waitForConfirmation: async () => ({
            txId: "at1rej",
            blockHeight: 5,
            status: "rejected",
            transitions: [],
          }),
        }),
      );

      await expect(contract.testRejected("mint", [])).resolves.toMatchObject({
        status: "rejected",
        rawOutputs: [],
      });
    });
  });

  describe("rawOutputAt", () => {
    it("returns the raw string at the requested ABI index", () => {
      const result = BaseContract.rawOutputAt(["foo", "bar"], "p.aleo", "t", 1);
      expect(result).toBe("bar");
    });

    it("throws TransactionShapeError with outputIndex populated when entry is missing", () => {
      try {
        BaseContract.rawOutputAt([], "token.aleo", "mint_private", 0);
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.outputIndex).toBe(0);
        expect(err.programId).toBe("token.aleo");
        expect(err.transition).toBe("mint_private");
        expect(err.message).toContain("ABI index 0");
      }
    });

    it("throws when the entry is not a string", () => {
      try {
        BaseContract.rawOutputAt([null as any], "p.aleo", "t", 0);
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.outputIndex).toBe(0);
      }
    });

    it("throws with the original ABI index when the entry is id-only", () => {
      try {
        BaseContract.rawOutputAt(
          [{ kind: "idOnly", type: "record_dynamic", id: "dynamic-id" }],
          "p.aleo",
          "t",
          0,
        );
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.outputIndex).toBe(0);
        expect(err.message).toContain("id-only output dynamic-id");
      }
    });
  });

  describe("makeEncryptedRecord", () => {
    it("creates a handle exposing program, recordName, ciphertext, decrypt, and match", () => {
      const handle = BaseContract.makeEncryptedRecord(
        "p.aleo",
        "Tok",
        "record1abc",
        (plaintext: string) => ({ raw: plaintext }),
      );
      expect(handle.program).toBe("p.aleo");
      expect(handle.recordName).toBe("Tok");
      expect(handle.ciphertext).toBe("record1abc");
      expect(typeof handle.decrypt).toBe("function");
      expect(typeof handle.match).toBe("function");
    });

    it("routes decrypt through BaseContract.decryptRecord with the supplied deserializer", async () => {
      networkStub.__setDecryptStubs({
        decryptRecordCiphertext: async (ct: string) => `{ amount: 100u128, _from: ${ct} }`,
      });
      const handle = BaseContract.makeEncryptedRecord(
        "p.aleo",
        "Tok",
        "record1xyz",
        (plaintext: string) => ({ decoded: plaintext }),
      );
      const result = await handle.decrypt("AViewKey1abc");
      expect(result).toEqual({ decoded: "{ amount: 100u128, _from: record1xyz }" });
    });

    it("match(matcher).decrypt(key) re-routes through the matcher's deserializer when identity matches", async () => {
      networkStub.__setDecryptStubs({
        decryptRecordCiphertext: async (ct: string) => `[plain ${ct}]`,
      });
      const handle = BaseContract.makeEncryptedRecord(
        "p.aleo",
        "Tok",
        "record1xyz",
        (plaintext: string) => ({ original: plaintext }),
      );
      const matcher = createRecordOutputMatcher({
        program: "p.aleo",
        recordName: "Tok",
        deserialize: (plaintext: string) => ({ viaMatcher: plaintext }),
      });
      const result = await handle.match(matcher).decrypt("AViewKey1abc");
      expect(result).toEqual({ viaMatcher: "[plain record1xyz]" });
    });

    it("match(matcher).decrypt(key) rejects with TransactionShapeError when matcher program/recordName differ", async () => {
      const handle = BaseContract.makeEncryptedRecord(
        "p.aleo",
        "Tok",
        "record1xyz",
        (plaintext: string) => ({ original: plaintext }),
      );
      const mismatchedMatcher = createRecordOutputMatcher({
        program: "other.aleo",
        recordName: "Tok",
        deserialize: (s: string) => s,
      });
      await expect(handle.match(mismatchedMatcher).decrypt("AViewKey1abc")).rejects.toMatchObject({
        kind: "TransactionShapeError",
      });
    });
  });

  describe("idOnlyRecordOutputAt", () => {
    const entry = { kind: "idOnly", type: "external_record", id: "ext-id" } as const;

    it("returns the id-only entry at the requested ABI index", () => {
      const result = BaseContract.idOnlyRecordOutputAt([entry], "p.aleo", "t", 0);
      expect(result).toBe(entry);
    });

    it("throws TransactionShapeError when the entry is a ciphertext string", () => {
      try {
        BaseContract.idOnlyRecordOutputAt(["record1abc"], "p.aleo", "t", 0);
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.outputIndex).toBe(0);
        expect(err.message).toContain("ciphertext string");
      }
    });

    it("throws TransactionShapeError when the entry is missing", () => {
      try {
        BaseContract.idOnlyRecordOutputAt([], "p.aleo", "t", 0);
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.outputIndex).toBe(0);
        expect(err.message).toContain("undefined");
      }
    });
  });

  describe("makeIdOnlyDynamicRecordHandle", () => {
    const SIBLING_CIPHERTEXT = "record1sibling";
    const entry = { kind: "idOnly", type: "record_dynamic", id: "dyn-id" } as const;
    const calleeMatcher = () => createRecordOutputMatcher({
      program: "callee.aleo",
      recordName: "Tok",
      deserialize: (plaintext: string) => ({ decoded: plaintext }),
    });
    const transitions = [
      {
        programId: "router.aleo",
        transitionName: "route_transfer",
        rawOutputs: [entry],
        transitionPublicKey: "tpk_router",
      },
      {
        programId: "callee.aleo",
        transitionName: "transfer",
        rawOutputs: [SIBLING_CIPHERTEXT, entry],
        transitionPublicKey: "tpk_callee",
      },
    ];

    it("constructs a handle with kind + type + id + transitions and a match method", () => {
      const handle = BaseContract.makeIdOnlyDynamicRecordHandle(entry, transitions);
      expect(handle.kind).toBe("idOnlyDynamicRecord");
      expect(handle.type).toBe("record_dynamic");
      expect(handle.id).toBe("dyn-id");
      expect(handle.transitions).toBe(transitions);
      expect(typeof handle.match).toBe("function");
    });

    it("match(matcher.from(...)).decrypt(key) resolves the sibling concrete output via the matcher's deserializer", async () => {
      networkStub.__setDecryptStubs({
        decryptRecordCiphertext: async (ct: string) => `[plain ${ct}]`,
      });
      const handle = BaseContract.makeIdOnlyDynamicRecordHandle(entry, transitions);
      const result = await handle.match(calleeMatcher().from("transfer", 0)).decrypt("AViewKey1abc");
      expect(result).toEqual({ decoded: `[plain ${SIBLING_CIPHERTEXT}]` });
    });

    it("match(matcher.at(transitionIndex, outputIndex)).decrypt(key) resolves positionally", async () => {
      networkStub.__setDecryptStubs({
        decryptRecordCiphertext: async (ct: string) => `[plain ${ct}]`,
      });
      const handle = BaseContract.makeIdOnlyDynamicRecordHandle(entry, transitions);
      const result = await handle.match(calleeMatcher().at(1, 0)).decrypt("AViewKey1abc");
      expect(result).toEqual({ decoded: `[plain ${SIBLING_CIPHERTEXT}]` });
    });

    it("throws IdOnlyRecordResolutionError { transition-not-found }", async () => {
      const handle = BaseContract.makeIdOnlyDynamicRecordHandle(entry, transitions);
      const missingMatcher = createRecordOutputMatcher({
        program: "missing.aleo",
        recordName: "Tok",
        deserialize: (s: string) => s,
      });
      await expect(
        handle.match(missingMatcher.from("nope", 0)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "transition-not-found",
      });
    });

    it("throws IdOnlyRecordResolutionError { transition-index-out-of-range }", async () => {
      const handle = BaseContract.makeIdOnlyDynamicRecordHandle(entry, transitions);
      await expect(
        handle.match(calleeMatcher().at(99, 0)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "transition-index-out-of-range",
      });
    });

    it("throws IdOnlyRecordResolutionError { program-mismatch } with expected/actual populated", async () => {
      const handle = BaseContract.makeIdOnlyDynamicRecordHandle(entry, transitions);
      // .at(0, 0) targets the router transition, but the matcher's program is
      // callee.aleo, so program-mismatch fires.
      await expect(
        handle.match(calleeMatcher().at(0, 0)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "program-mismatch",
        expectedProgram: "callee.aleo",
        actualProgram: "router.aleo",
      });
    });

    it("throws IdOnlyRecordResolutionError { not-a-ciphertext } when the slot is an id-only entry", async () => {
      const handle = BaseContract.makeIdOnlyDynamicRecordHandle(entry, transitions);
      // .at(1, 1) points at the callee transition's id-only dyn-record entry
      // sitting alongside the sibling concrete output at index 0. The matcher's
      // program matches the callee so program-mismatch doesn't fire first.
      await expect(
        handle.match(calleeMatcher().at(1, 1)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "not-a-ciphertext",
      });
    });
  });

  describe("makeIdOnlyExternalRecordHandle", () => {
    const CALLEE_CIPHERTEXT = "record1callee";
    const entry = { kind: "idOnly", type: "external_record", id: "ext-id" } as const;
    const calleeMatcher = () => createRecordOutputMatcher({
      program: "callee.aleo",
      recordName: "Foo",
      deserialize: (plaintext: string) => ({ decoded: plaintext }),
    });
    const transitions = [
      {
        programId: "caller.aleo",
        transitionName: "wrap",
        rawOutputs: [entry],
        transitionPublicKey: "tpk_caller",
      },
      {
        programId: "callee.aleo",
        transitionName: "mint",
        rawOutputs: [CALLEE_CIPHERTEXT],
        transitionPublicKey: "tpk_callee",
      },
    ];

    it("constructs the handle with kind + type + id + transitions and a match method", () => {
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, transitions);
      expect(handle.kind).toBe("idOnlyExternalRecord");
      expect(handle.type).toBe("external_record");
      expect(handle.id).toBe("ext-id");
      expect(handle.transitions).toBe(transitions);
      expect(typeof handle.match).toBe("function");
    });

    it("match(matcher.from(...)).decrypt(key) resolves the callee transition via the matcher", async () => {
      networkStub.__setDecryptStubs({
        decryptRecordCiphertext: async (ct: string) => `[plain ${ct}]`,
      });
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, transitions);
      const result = await handle.match(calleeMatcher().from("mint", 0)).decrypt("AViewKey1abc");
      expect(result).toEqual({ decoded: `[plain ${CALLEE_CIPHERTEXT}]` });
    });

    it("match(matcher.at(transitionIndex, outputIndex)).decrypt(key) resolves positionally", async () => {
      networkStub.__setDecryptStubs({
        decryptRecordCiphertext: async (ct: string) => `[plain ${ct}]`,
      });
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, transitions);
      const result = await handle.match(calleeMatcher().at(1, 0)).decrypt("AViewKey1abc");
      expect(result).toEqual({ decoded: `[plain ${CALLEE_CIPHERTEXT}]` });
    });

    it("throws IdOnlyRecordResolutionError { transition-not-found }", async () => {
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, transitions);
      const missingMatcher = createRecordOutputMatcher({
        program: "missing.aleo",
        recordName: "Foo",
        deserialize: (s: string) => s,
      });
      await expect(
        handle.match(missingMatcher.from("nope", 0)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "transition-not-found",
      });
    });

    it("throws IdOnlyRecordResolutionError { transition-not-unique } when multiple matches and no { match } option", async () => {
      const dupTransitions = [
        ...transitions,
        {
          programId: "callee.aleo",
          transitionName: "mint",
          rawOutputs: ["record1other"],
          transitionPublicKey: "tpk_callee2",
        },
      ];
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, dupTransitions);
      await expect(
        handle.match(calleeMatcher().from("mint", 0)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "transition-not-unique",
      });
    });

    it("from(name, idx, { match: n }) resolves the n-th match", async () => {
      networkStub.__setDecryptStubs({
        decryptRecordCiphertext: async (ct: string) => `[plain ${ct}]`,
      });
      const dupTransitions = [
        ...transitions,
        {
          programId: "callee.aleo",
          transitionName: "mint",
          rawOutputs: ["record1other"],
          transitionPublicKey: "tpk_callee2",
        },
      ];
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, dupTransitions);
      const result = await handle.match(calleeMatcher().from("mint", 0, { match: 1 })).decrypt("AViewKey1abc");
      expect(result).toEqual({ decoded: "[plain record1other]" });
    });

    it("throws IdOnlyRecordResolutionError { transition-index-out-of-range }", async () => {
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, transitions);
      await expect(
        handle.match(calleeMatcher().at(99, 0)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "transition-index-out-of-range",
      });
    });

    it("throws IdOnlyRecordResolutionError { transition-match-index-out-of-range }", async () => {
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, transitions);
      await expect(
        handle.match(calleeMatcher().from("mint", 0, { match: 5 })).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "transition-match-index-out-of-range",
      });
    });

    it("throws IdOnlyRecordResolutionError { program-mismatch } with expected/actual populated", async () => {
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, transitions);
      await expect(
        handle.match(calleeMatcher().at(0, 0)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "program-mismatch",
        expectedProgram: "callee.aleo",
        actualProgram: "caller.aleo",
      });
    });

    it("throws IdOnlyRecordResolutionError { not-a-ciphertext } when the slot is an id-only entry", async () => {
      const handle = BaseContract.makeIdOnlyExternalRecordHandle(entry, transitions);
      // Use a matcher pointed at the caller's own program so program-mismatch
      // doesn't fire first; the output at (0, 0) is the id-only entry itself.
      const callerMatcher = createRecordOutputMatcher({
        program: "caller.aleo",
        recordName: "Wrap",
        deserialize: (s: string) => s,
      });
      await expect(
        handle.match(callerMatcher.at(0, 0)).decrypt("AViewKey1abc"),
      ).rejects.toMatchObject({
        kind: "IdOnlyRecordResolutionError",
        reason: "not-a-ciphertext",
      });
    });
  });

  describe("makeEncryptedValue", () => {
    const CT = "ciphertext1qyqxyz";
    const TPK = "tpk_test_group";

    it("creates a handle wrapping ciphertext + decrypt closure", () => {
      const handle = BaseContract.makeEncryptedValue(CT, TPK, "p.aleo", "t", 1, BaseContract.parseBigInt);
      expect(handle.ciphertext).toBe(CT);
      expect(typeof handle.decrypt).toBe("function");
    });

    it("routes decrypt through decryptValueCiphertext with tpk/program/function/globalIndex", async () => {
      let captured: any = null;
      networkStub.__setDecryptStubs({
        decryptValueCiphertext: async (
          ciphertext: string, viewKey: string, tpk: string,
          programId: string, transitionName: string, globalIndex: number,
        ) => {
          captured = { ciphertext, viewKey, tpk, programId, transitionName, globalIndex };
          return "10000u64";
        },
      });
      const handle = BaseContract.makeEncryptedValue(CT, TPK, "governance.aleo", "compare_strategies", 1, BaseContract.parseBigInt);
      const value = await handle.decrypt("AViewKey1abc");
      expect(value).toBe(10000n);
      expect(captured).toEqual({
        ciphertext: CT,
        viewKey: "AViewKey1abc",
        tpk: TPK,
        programId: "governance.aleo",
        transitionName: "compare_strategies",
        globalIndex: 1,
      });
    });

    it("captures ciphertext/tpk/program/function/globalIndex independently per instance", async () => {
      networkStub.__setDecryptStubs({
        decryptValueCiphertext: async (_ct: string, _vk: string, _tpk: string, _p: string, _t: string, idx: number) => `${idx}u64`,
      });
      const h1 = BaseContract.makeEncryptedValue("ct1", "tpk1", "p.aleo", "t", 1, BaseContract.parseBigInt);
      const h2 = BaseContract.makeEncryptedValue("ct2", "tpk2", "p.aleo", "t", 2, BaseContract.parseBigInt);
      expect(await h1.decrypt("AViewKey1abc")).toBe(1n);
      expect(await h2.decrypt("AViewKey1abc")).toBe(2n);
    });

    it("wraps NetworkValueDecryptionError from the SDK as LocalValueDecryptionError with outputIndex populated", async () => {
      networkStub.__setDecryptStubs({
        decryptValueCiphertext: async () => {
          throw new networkStub.NetworkValueDecryptionError("bad ciphertext", CT.slice(0, 16));
        },
      });
      const handle = BaseContract.makeEncryptedValue(CT, TPK, "p.aleo", "t", 5, BaseContract.parseBigInt);
      try {
        await handle.decrypt("AViewKey1abc");
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err).toBeInstanceOf(LocalValueDecryptionError);
        expect(err.kind).toBe("LocalValueDecryptionError");
        expect(err.outputIndex).toBe(5);
        expect(err.programId).toBe("p.aleo");
        expect(err.transition).toBe("t");
        expect(err.message).toMatch(/bad ciphertext/);
      }
    });

    it("wraps deserializer failures (incl. LionDenTypechainError subclasses) as LocalValueDecryptionError", async () => {
      networkStub.__setDecryptStubs({
        decryptValueCiphertext: async () => "not-a-bigint",
      });
      // Deserializer throws TransitionInputError (a LionDenTypechainError) —
      // the narrow pass-through rule must still wrap it (not let it leak).
      const handle = BaseContract.makeEncryptedValue(
        CT, TPK, "p.aleo", "t", 0,
        (_plaintext: string) => {
          throw new TransitionInputError("fake input error");
        },
      );
      try {
        await handle.decrypt("AViewKey1abc");
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("LocalValueDecryptionError");
        expect(err.outputIndex).toBe(0);
        expect(err.cause).toBeInstanceOf(TransitionInputError);
      }
    });

    it("passes RecordDecryptionKeyError through unchanged when the key shape is invalid", async () => {
      const handle = BaseContract.makeEncryptedValue(CT, TPK, "p.aleo", "t", 0, BaseContract.parseBigInt);
      for (const badKey of ["", "junk", {} as any, null as any]) {
        try {
          await handle.decrypt(badKey);
          throw new Error("expected throw for key=" + JSON.stringify(badKey));
        } catch (err: any) {
          expect(err).toBeInstanceOf(RecordDecryptionKeyError);
          expect(err.kind).toBe("RecordDecryptionKeyError");
        }
      }
    });
  });

  describe("settleTyped / expectAcceptedTyped", () => {
    it("settleTyped populates outputs on accepted", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "atOk" }),
          waitForConfirmation: async () => ({
            txId: "atOk",
            blockHeight: 7,
            status: "accepted",
            transitions: [{ programId: "token.aleo", transitionName: "mint", rawOutputs: ["42u128"], transitionPublicKey: "tpk_test_mint" }],
          }),
        }),
      );
      const project = (raw: readonly string[]): bigint =>
        BigInt(BaseContract.rawOutputAt(raw, "token.aleo", "mint", 0).replace(/u128$/, ""));
      const result = await contract.testSettleTyped("mint", [], {}, project);
      expect(result.status).toBe("accepted");
      expect(result.outputs).toBe(42n);
      expect(result.rawOutputs).toEqual(["42u128"]);
    });

    it("settleTyped returns RejectedTransition without an outputs field on rejection", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "atRej" }),
          waitForConfirmation: async () => ({
            txId: "atRej",
            blockHeight: 7,
            status: "rejected",
            transitions: [],
          }),
        }),
      );
      const result = await contract.testSettleTyped("mint", [], {}, () => 999n);
      expect(result.status).toBe("rejected");
      expect((result as any).outputs).toBeUndefined();
    });

    it("expectAcceptedTyped throws OnChainRejectedError on rejection", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "atRej2" }),
          waitForConfirmation: async () => ({
            txId: "atRej2",
            blockHeight: 7,
            status: "rejected",
            transitions: [],
          }),
        }),
      );
      await expect(
        contract.testExpectAcceptedTyped("mint", [], {}, () => 1n),
      ).rejects.toMatchObject({ kind: "OnChainRejectedError" });
    });

    it("rethrows TransactionShapeError from the projector unchanged (with outputIndex)", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "atShape" }),
          waitForConfirmation: async () => ({
            txId: "atShape",
            blockHeight: 7,
            status: "accepted",
            transitions: [{ programId: "token.aleo", transitionName: "mint", rawOutputs: [], transitionPublicKey: "tpk_test_mint" }],
          }),
        }),
      );
      try {
        await contract.testSettleTyped("mint", [], {}, (raw: readonly string[]) =>
          BaseContract.rawOutputAt(raw, "token.aleo", "mint", 0),
        );
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.outputIndex).toBe(0);
        // Message must be the original rawOutputAt message, not the wrapper.
        expect(err.message).toContain("ABI index 0");
        expect(err.message).not.toContain("On-chain output decoding failed");
      }
    });

    it("wraps non-shape projector errors (e.g. TransitionInputError) as TransactionShapeError with .cause", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "atWrap" }),
          waitForConfirmation: async () => ({
            txId: "atWrap",
            blockHeight: 7,
            status: "accepted",
            transitions: [{ programId: "token.aleo", transitionName: "mint", rawOutputs: ["malformed-addr"], transitionPublicKey: "tpk_test_mint" }],
          }),
        }),
      );
      try {
        await contract.testSettleTyped("mint", [], {}, (raw: readonly string[]) =>
          BaseContract.parseAddress(BaseContract.rawOutputAt(raw, "token.aleo", "mint", 0)),
        );
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.message).toContain("On-chain output decoding failed");
        expect(err.cause).toBeDefined();
        expect((err.cause as any).kind).toBe("TransitionInputError");
      }
    });

    it("wraps LocalRecordDecryptionError from projector as TransactionShapeError with .cause", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "atLocalDec" }),
          waitForConfirmation: async () => ({
            txId: "atLocalDec",
            blockHeight: 7,
            status: "accepted",
            transitions: [{ programId: "token.aleo", transitionName: "mint", rawOutputs: ["record1abc"], transitionPublicKey: "tpk_test_mint" }],
          }),
        }),
      );
      try {
        await contract.testSettleTyped("mint", [], {}, () => {
          // Simulate a per-output decoder that throws LocalRecordDecryptionError.
          // (Generated projectors build EncryptedRecord handles instead of decrypting
          // inline, but custom escape-hatch projectors might decrypt synchronously
          // and propagate this error class.)
          throw new LocalRecordDecryptionError("ciphertext rejected by SDK");
        });
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.message).toContain("On-chain output decoding failed");
        expect((err.cause as any).kind).toBe("LocalRecordDecryptionError");
      }
    });

    it("wraps native Error from projector as TransactionShapeError with .cause", async () => {
      const contract = createTestContract("token.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: [], txId: "atNative" }),
          waitForConfirmation: async () => ({
            txId: "atNative",
            blockHeight: 7,
            status: "accepted",
            transitions: [{ programId: "token.aleo", transitionName: "mint", rawOutputs: ["x"], transitionPublicKey: "tpk_test_mint" }],
          }),
        }),
      );
      try {
        await contract.testSettleTyped("mint", [], {}, () => {
          throw new Error("kaboom");
        });
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err.kind).toBe("TransactionShapeError");
        expect(err.message).toContain("kaboom");
        expect((err.cause as Error).message).toBe("kaboom");
      }
    });
  });

  // -------------------------------------------------------------------------
  // runtime imports
  // -------------------------------------------------------------------------

  describe("runtime imports", () => {
    it("forwards instance-level imports into network.execute", async () => {
      const spy = vi.fn().mockResolvedValue({ outputs: [], txId: "at1ok" });
      const contract = createTestContract("governance.aleo", {
        imports: ["voting_power.aleo"],
      });
      contract.connect(mockLre({ execute: spy }));

      await contract.testExecuteLocal("get_voting_power", []);

      expect(spy).toHaveBeenCalledOnce();
      const opts = spy.mock.calls[0]![3];
      expect(opts.imports).toEqual(["voting_power.aleo"]);
    });

    it("merges instance-level and per-call imports", async () => {
      const spy = vi.fn().mockResolvedValue({ outputs: [], txId: "at1ok" });
      const contract = createTestContract("governance.aleo", {
        imports: ["voting_power.aleo"],
      });
      contract.connect(mockLre({ execute: spy }));

      await contract.testExecuteLocal("get_voting_power", [], {
        imports: ["quadratic_power.aleo"],
      });

      const opts = spy.mock.calls[0]![3];
      expect(opts.imports).toEqual(["voting_power.aleo", "quadratic_power.aleo"]);
    });

    it("omits imports from the wire when neither layer is set", async () => {
      const spy = vi.fn().mockResolvedValue({ outputs: [], txId: "at1ok" });
      const contract = createTestContract("hello.aleo");
      contract.connect(mockLre({ execute: spy }));

      await contract.testExecuteLocal("main", ["1u32"]);

      const opts = spy.mock.calls[0]![3];
      expect(opts.imports).toBeUndefined();
    });

    it("withSigner clone preserves instanceImports", async () => {
      const spy = vi.fn().mockResolvedValue({ outputs: [], txId: "at1ok" });
      const contract = createTestContract("governance.aleo", {
        imports: ["voting_power.aleo"],
      });
      contract.connect(mockLre({ execute: spy }));

      const withSig = contract.withSigner({ privateKey: "k", address: "aleo1signer" });
      await (withSig as any).testExecuteLocal("get_voting_power", []);

      const opts = spy.mock.calls[0]![3];
      expect(opts.imports).toEqual(["voting_power.aleo"]);
      expect(opts.signer).toEqual({ privateKey: "k", address: "aleo1signer" });
    });
  });
});
