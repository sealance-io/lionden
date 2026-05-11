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
    "export let decryptRecordCiphertext = async () => { throw new NetworkRecordDecryptionError('stub', ''); };",
    "export let deriveViewKey = async () => { throw new NetworkRecordDecryptionError('stub deriveViewKey', ''); };",
    "export function __setDecryptStubs(stubs) {",
    "  if (stubs.decryptRecordCiphertext) decryptRecordCiphertext = stubs.decryptRecordCiphertext;",
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
function createTestContract(programId = "test.aleo") {
  class TestContract extends BaseContract {
    constructor(id = programId) {
      super(id);
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
    async testQueryMapping(...args: any[]) {
      return this.queryMapping(...args);
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
            transitions: [{ programId: "hello.aleo", transitionName: "main", rawOutputs: [] }],
          }),
        }),
      );

      await expect(contract.testAccepted("main", [])).resolves.toEqual({
        txId: "at1ok",
        blockHeight: 12,
        status: "accepted",
        rawOutputs: [],
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
              { programId: "credits.aleo", transitionName: "fee_public", rawOutputs: [] },
              { programId: "token.aleo", transitionName: "mint", rawOutputs: ["record1xyz"] },
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
              { programId: "credits.aleo", transitionName: "fee_public", rawOutputs: [] },
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
              { programId: "token.aleo", transitionName: "mint", rawOutputs: ["a"] },
              { programId: "token.aleo", transitionName: "mint", rawOutputs: ["b"] },
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
});
