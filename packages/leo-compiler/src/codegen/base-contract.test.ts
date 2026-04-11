/**
 * Runtime behavior tests for the generated BaseContract class.
 *
 * Rather than importing the golden snapshot (which could be stale),
 * this test generates fresh output via generateBaseContract(), transpiles
 * it to JS, writes to a temp .mjs file, and dynamically imports it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { generateBaseContract } from "./typescript-generator.js";

// The dynamically loaded BaseContract class
let BaseContract: any;
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
  const outPath = join(tmpDir, "BaseContract.mjs");
  writeFileSync(outPath, transpiled.outputText);

  const mod = await import(outPath);
  BaseContract = mod.BaseContract;
});

afterAll(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** Create a concrete subclass to access protected methods. */
function createTestContract(programId = "test.aleo") {
  class TestContract extends BaseContract {
    constructor(id: string) {
      super(id);
    }
    // Expose protected methods for testing
    async testExecute(...args: any[]) {
      return this.execute(...args);
    }
    async testExecuteLocal(...args: any[]) {
      return this.executeLocal(...args);
    }
    async testBroadcast(...args: any[]) {
      return this.broadcast(...args);
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
    it("throws when execute is called without connect()", async () => {
      const contract = createTestContract();

      await expect(
        contract.testExecute("main", ["1u32"]),
      ).rejects.toThrow("Contract not connected to LRE");
    });

    it("connect() returns this for chaining", () => {
      const contract = createTestContract();
      const result = contract.connect(mockLre());

      expect(result).toBe(contract);
    });
  });

  // -------------------------------------------------------------------------
  // execute / executeLocal / broadcast
  // -------------------------------------------------------------------------

  describe("execute()", () => {
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

      const result = await contract.testExecute("main", ["3u32", "5u32"], { fee: 100 });

      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toEqual([
        "hello.aleo",
        "main",
        ["3u32", "5u32"],
        { fee: 100 },
      ]);
      expect(result.outputs).toEqual(["8u32"]);
    });

    it("throws when lre.network is missing", async () => {
      const contract = createTestContract();
      contract.connect({ network: null } as any);

      await expect(
        contract.testExecute("main", []),
      ).rejects.toThrow("Network not available on LRE");
    });

    it("throws when lre.network.execute is not a function", async () => {
      const contract = createTestContract();
      contract.connect({ network: { execute: "not-a-fn" } } as any);

      await expect(
        contract.testExecute("main", []),
      ).rejects.toThrow("Network not available on LRE");
    });
  });

  describe("executeLocal()", () => {
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

  describe("broadcast()", () => {
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

      await contract.testBroadcast("transfer", ["aleo1abc", "100u64"], { fee: 50 });

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
        contract.testBroadcast("main", []),
      ).rejects.toThrow("Expected on-chain execution of hello.aleo/main to return a transaction ID");
    });

    it("returns result when txId is present", async () => {
      const contract = createTestContract("hello.aleo");
      contract.connect(
        mockLre({
          execute: async () => ({ outputs: ["42u32"], txId: "at1ok" }),
        }),
      );

      const result = await contract.testBroadcast("main", []);

      expect(result.txId).toBe("at1ok");
      expect(result.outputs).toEqual(["42u32"]);
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
      ).rejects.toThrow("Network not available on LRE");
    });

    it("throws when getMappingValue is not a function", async () => {
      const contract = createTestContract();
      contract.connect({ network: { getMappingValue: 42 } } as any);

      await expect(
        contract.testQueryMapping("balances", "aleo1abc"),
      ).rejects.toThrow("Network not available on LRE");
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
      ])("strips suffix from %s → %s", (input, expected) => {
        expect(BaseContract.stripSuffix(input)).toBe(expected);
      });
    });

    describe("parseBoolean", () => {
      it("parses 'true' to true", () => {
        expect(BaseContract.parseBoolean("true")).toBe(true);
      });

      it("parses 'false' to false", () => {
        expect(BaseContract.parseBoolean("false")).toBe(false);
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
});
