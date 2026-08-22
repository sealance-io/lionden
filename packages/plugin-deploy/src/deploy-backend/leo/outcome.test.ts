import { type LeoCliCapture, loadLeoCliCapture } from "@lionden/test-internals";
import { describe, expect, it } from "vitest";
import { LeoDeployError } from "./errors.js";
import { type LeoRunArtifacts, readLeoOutcome, savedTransactionFileName } from "./outcome.js";

/**
 * Every case here runs against a verbatim capture of the real Leo 4.3.2 CLI
 * rather than a hand-written approximation, because the behaviours that matter
 * most — exit 0 with nothing built, exit 0 on an on-chain rejection — are
 * exactly the ones a hand-written fake would get wrong.
 */
function artifactsFrom(capture: LeoCliCapture): LeoRunArtifacts {
  return {
    exitCode: capture.exitCode,
    signal: null,
    stdout: capture.stdout,
    stderr: capture.stderr,
    savedFiles: capture.savedFiles,
    jsonOutput: capture.jsonOutput,
  };
}

describe("savedTransactionFileName", () => {
  /**
   * Keyed by program id, not transaction id — the correction the capture corpus
   * forced. Getting this wrong makes every successful run look like a no-file
   * failure.
   */
  it("names the file after the program", () => {
    expect(savedTransactionFileName("spike_a.aleo")).toBe("spike_a.aleo.deployment.json");
  });

  it("uses the same suffix for upgrades", () => {
    const capture = loadLeoCliCapture("upgrade-save");
    expect([...capture.savedFiles.keys()]).toEqual([savedTransactionFileName("spike_up.aleo")]);
  });
});

describe("readLeoOutcome", () => {
  describe("successful deploy", () => {
    const capture = loadLeoCliCapture("deploy-single");

    it("returns the saved transaction byte for byte", () => {
      const outcome = readLeoOutcome("deploy", "spike_a.aleo", artifactsFrom(capture));
      expect(outcome.transaction).toBe(capture.savedFiles.get("spike_a.aleo.deployment.json"));
    });

    /**
     * The file is a bare snarkVM transaction — no wrapper — and is broadcast
     * unmodified. Re-serializing it would be a silent corruption risk.
     */
    it("hands back a bare transaction, not a wrapper", () => {
      const outcome = readLeoOutcome("deploy", "spike_a.aleo", artifactsFrom(capture));
      const parsed = JSON.parse(outcome.transaction);
      expect(Object.keys(parsed).sort()).toEqual(["deployment", "fee", "id", "owner", "type"]);
      expect(parsed.type).toBe("deploy");
    });

    /**
     * The saved transaction's own id, not `--json-output`'s copy — that is the
     * blob being broadcast. They agree in every captured run, which is asserted
     * here so a future divergence surfaces as a failure rather than a silently
     * mis-recorded txId.
     */
    it("reads the transaction id from the transaction itself", () => {
      const outcome = readLeoOutcome("deploy", "spike_a.aleo", artifactsFrom(capture));
      const savedId = JSON.parse(capture.savedFiles.get("spike_a.aleo.deployment.json")!).id;
      expect(outcome.transactionId).toBe(savedId);
      expect(JSON.parse(capture.jsonOutput!).deployments[0].transaction_id).toBe(savedId);
    });

    it("reads costs from --json-output", () => {
      const outcome = readLeoOutcome("deploy", "spike_a.aleo", artifactsFrom(capture));
      expect(outcome.stats?.totalCost).toBe(1_001_010_041);
      expect(outcome.stats?.namespaceCost).toBe(1_000_000_000);
    });
  });

  describe("successful upgrade", () => {
    it("parses identically to a deploy, at edition 1", () => {
      const capture = loadLeoCliCapture("upgrade-save");
      const outcome = readLeoOutcome("upgrade", "spike_up.aleo", artifactsFrom(capture));
      expect(JSON.parse(outcome.transaction).deployment.edition).toBe(1);
      expect(outcome.transactionId).toMatch(/^at1/);
    });
  });

  /**
   * The headline finding: Leo exits 0 when `--skip` matches every program, so a
   * backend that trusted the exit code would report a successful deployment of
   * nothing.
   */
  describe("exit 0 with nothing built", () => {
    const capture = loadLeoCliCapture("deploy-skip-all");

    it("is fatal despite the zero exit code", () => {
      expect(capture.exitCode).toBe(0);
      expect(capture.savedFiles.size).toBe(0);
      expect(() => readLeoOutcome("deploy", "spike_main.aleo", artifactsFrom(capture))).toThrow(
        LeoDeployError,
      );
    });

    it("says outright that exit 0 is not success here", () => {
      try {
        readLeoOutcome("deploy", "spike_main.aleo", artifactsFrom(capture));
        expect.unreachable();
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("exited successfully but wrote no transaction");
        expect(message).toContain("A zero exit code does not mean success");
        expect(message).toContain("spike_main.aleo.deployment.json");
      }
    });

    it("reports the outcome stage", () => {
      try {
        readLeoOutcome("deploy", "spike_main.aleo", artifactsFrom(capture));
        expect.unreachable();
      } catch (error) {
        expect((error as LeoDeployError).stage).toBe("outcome");
      }
    });
  });

  /**
   * A constructor-rejected upgrade also exits 0, with `Transaction rejected.`
   * on stdout and no `broadcast` key in the JSON. lionden never passes
   * `--broadcast`, so this shape should not arise in practice — but if it ever
   * does, it must not read as success.
   */
  describe("exit 0 after an on-chain rejection", () => {
    const capture = loadLeoCliCapture("upgrade-rejected-by-constructor");

    it("is fatal", () => {
      expect(capture.exitCode).toBe(0);
      expect(() => readLeoOutcome("upgrade", "spike_a.aleo", artifactsFrom(capture))).toThrow(
        LeoDeployError,
      );
    });

    it("surfaces the rejection marker in the message", () => {
      try {
        readLeoOutcome("upgrade", "spike_a.aleo", artifactsFrom(capture));
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain("The network rejected the transaction.");
      }
    });
  });

  describe("multi-program runs", () => {
    /**
     * `--skip` should have narrowed this to one program. More than one saved
     * transaction means lionden would broadcast one and silently drop the rest,
     * with no record written for them.
     */
    it("rejects a run that produced more than one transaction", () => {
      const capture = loadLeoCliCapture("deploy-multi");
      expect(capture.savedFiles.size).toBe(3);
      expect(() => readLeoOutcome("deploy", "spike_main.aleo", artifactsFrom(capture))).toThrow(
        /produced 3 transactions instead of one/,
      );
    });

    it("names the unexpected transactions", () => {
      const capture = loadLeoCliCapture("deploy-multi");
      try {
        readLeoOutcome("deploy", "spike_main.aleo", artifactsFrom(capture));
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain("spike_a.aleo.deployment.json");
        expect((error as Error).message).toContain("zspike_a.aleo.deployment.json");
      }
    });

    it("accepts a correctly narrowed run", () => {
      const capture = loadLeoCliCapture("deploy-skip-collision");
      const outcome = readLeoOutcome("deploy", "spike_main.aleo", artifactsFrom(capture));
      expect(JSON.parse(outcome.transaction).type).toBe("deploy");
    });
  });

  /**
   * The file name is Leo's label for the blob, not evidence about what is in it.
   * Everything downstream — broadcast, recorded txId, deployment record — trusts
   * these bytes, so each case here is one that a name-only check would wave
   * through and then record as this program's deployment.
   */
  describe("the saved file must actually be the requested deployment", () => {
    const capture = loadLeoCliCapture("deploy-single");

    /** A real capture with the saved transaction swapped for `text`. */
    function withSaved(text: string): LeoRunArtifacts {
      return {
        ...artifactsFrom(capture),
        savedFiles: new Map([["spike_a.aleo.deployment.json", text]]),
      };
    }

    it("rejects an empty file", () => {
      expect(() => readLeoOutcome("deploy", "spike_a.aleo", withSaved(""))).toThrow(
        /saved an empty transaction file/,
      );
    });

    it("rejects a whitespace-only file", () => {
      expect(() => readLeoOutcome("deploy", "spike_a.aleo", withSaved("\n  \n"))).toThrow(
        /saved an empty transaction file/,
      );
    });

    it("rejects a truncated write", () => {
      const good = capture.savedFiles.get("spike_a.aleo.deployment.json")!;
      expect(() => readLeoOutcome("deploy", "spike_a.aleo", withSaved(good.slice(0, 400)))).toThrow(
        /not valid JSON/,
      );
    });

    it("rejects a JSON document that is not an object", () => {
      expect(() => readLeoOutcome("deploy", "spike_a.aleo", withSaved("[1,2,3]"))).toThrow(
        /not a JSON object/,
      );
    });

    it("rejects a transaction that is not a deployment", () => {
      const execute = JSON.stringify({ type: "execute", id: "at1exec", execution: {} });
      expect(() => readLeoOutcome("deploy", "spike_a.aleo", withSaved(execute))).toThrow(
        /of type "execute", not a deployment/,
      );
    });

    it("rejects a deployment with no program payload", () => {
      const noProgram = JSON.stringify({ type: "deploy", id: "at1x", deployment: { edition: 0 } });
      expect(() => readLeoOutcome("deploy", "spike_a.aleo", withSaved(noProgram))).toThrow(
        /no program payload/,
      );
    });

    it("rejects a program payload with no declaration to check", () => {
      const noDecl = JSON.stringify({
        type: "deploy",
        id: "at1x",
        deployment: { edition: 0, program: "function main:\n" },
      });
      expect(() => readLeoOutcome("deploy", "spike_a.aleo", withSaved(noDecl))).toThrow(
        /no `program <id>;` declaration/,
      );
    });

    /**
     * The case the reviewer named: a stale or misdirected file under the right
     * name. Broadcasting it would record `other.aleo`'s bytecode as
     * `spike_a.aleo`'s deployment.
     */
    it("rejects a deployment of a different program under the expected name", () => {
      const other = JSON.stringify({
        type: "deploy",
        id: "at1other",
        deployment: { edition: 0, program: "program other.aleo;\n\nfunction main:\n" },
      });
      expect(() => readLeoOutcome("deploy", "spike_a.aleo", withSaved(other))).toThrow(
        /deployment of "other\.aleo", not "spike_a\.aleo"/,
      );
    });

    it("reports the outcome stage and does not return the bytes", () => {
      try {
        readLeoOutcome("deploy", "spike_a.aleo", withSaved(""));
        expect.unreachable();
      } catch (error) {
        expect((error as LeoDeployError).stage).toBe("outcome");
        expect((error as Error).message).toContain("was not broadcast");
      }
    });

    /**
     * The declaration follows the `import` lines in Aleo bytecode, so a
     * first-line match would read the wrong id for any program with imports.
     */
    it("reads the declaration past leading imports", () => {
      const withImports = loadLeoCliCapture("deploy-network-dep");
      const program = JSON.parse(withImports.savedFiles.get("spike_net.aleo.deployment.json")!)
        .deployment.program;
      expect(program.startsWith("import ")).toBe(true);
      expect(() =>
        readLeoOutcome("deploy", "spike_net.aleo", artifactsFrom(withImports)),
      ).not.toThrow();
    });

    it("returns the original bytes, not a re-serialization", () => {
      const outcome = readLeoOutcome("deploy", "spike_a.aleo", artifactsFrom(capture));
      const original = capture.savedFiles.get("spike_a.aleo.deployment.json")!;
      expect(outcome.transaction).toBe(original);
      // Distinct from `JSON.stringify(JSON.parse(original))` — proving the bytes
      // are passed through rather than round-tripped.
      expect(outcome.transaction).not.toBe(JSON.stringify(JSON.parse(original)));
    });

    it("accepts an upgrade, which is a deployment at a higher edition", () => {
      const upgrade = loadLeoCliCapture("upgrade-save");
      expect(() =>
        readLeoOutcome("upgrade", "spike_up.aleo", artifactsFrom(upgrade)),
      ).not.toThrow();
    });
  });

  describe("non-zero exit", () => {
    /**
     * `--save` needs a reachable endpoint — there is no offline build — and on
     * that path Leo writes no `--json-output` file at all, so a missing file
     * must be an ordinary failure mode rather than a parse error.
     */
    it("is fatal and reports the exit code", () => {
      const capture = loadLeoCliCapture("deploy-endpoint-unreachable");
      expect(capture.exitCode).toBe(213);
      expect(capture.jsonOutput).toBeNull();
      expect(() => readLeoOutcome("deploy", "spike_up.aleo", artifactsFrom(capture))).toThrow(
        /failed with exit code 213/,
      );
    });

    it("embeds the Leo output in the message, where bin.ts will print it", () => {
      const capture = loadLeoCliCapture("deploy-endpoint-unreachable");
      try {
        readLeoOutcome("deploy", "spike_up.aleo", artifactsFrom(capture));
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain("Failed to get consensus version");
      }
    });

    it("still fails when the consensus version is pinned", () => {
      const capture = loadLeoCliCapture("deploy-endpoint-unreachable-consensus-pinned");
      expect(capture.exitCode).toBe(248);
      expect(() => readLeoOutcome("deploy", "spike_up.aleo", artifactsFrom(capture))).toThrow(
        LeoDeployError,
      );
    });
  });

  describe("--json-output robustness", () => {
    const capture = loadLeoCliCapture("deploy-single");

    it("succeeds when the file was never written, and still knows the txId", () => {
      const outcome = readLeoOutcome("deploy", "spike_a.aleo", {
        ...artifactsFrom(capture),
        jsonOutput: null,
      });
      expect(outcome.transaction).toBeTruthy();
      // Recoverable from the transaction, so a missing `--json-output` costs
      // only the cost breakdown.
      expect(outcome.transactionId).toMatch(/^at1/);
      expect(outcome.stats).toBeUndefined();
    });

    it("succeeds when the file is malformed", () => {
      const outcome = readLeoOutcome("deploy", "spike_a.aleo", {
        ...artifactsFrom(capture),
        jsonOutput: "{ not json",
      });
      expect(outcome.transaction).toBeTruthy();
      expect(outcome.stats).toBeUndefined();
    });

    /**
     * `stats` has two shapes: four constraint fields appear only when a
     * deployment certificate was generated. Both must parse.
     */
    it("parses the certificate-bearing stats shape", () => {
      const withCert = loadLeoCliCapture("deploy-with-certificate");
      expect(withCert.jsonOutput).toContain("total_constraints");
      const outcome = readLeoOutcome("deploy", "spike_net.aleo", artifactsFrom(withCert));
      expect(outcome.stats?.totalCost).toBeGreaterThan(0);
    });

    it("parses the certificate-free stats shape", () => {
      const noCert = loadLeoCliCapture("deploy-network-dep");
      expect(noCert.jsonOutput).not.toContain("total_constraints");
      const outcome = readLeoOutcome("deploy", "spike_net.aleo", artifactsFrom(noCert));
      expect(outcome.stats?.totalCost).toBeGreaterThan(0);
    });
  });

  describe("signals", () => {
    it("reports a killed process and points at Leo's key cache", () => {
      const capture = loadLeoCliCapture("deploy-single");
      expect(() =>
        readLeoOutcome("deploy", "spike_a.aleo", {
          ...artifactsFrom(capture),
          exitCode: null,
          signal: "SIGKILL",
        }),
      ).toThrow(/terminated by signal SIGKILL[\s\S]*~\/\.aleo/);
    });
  });
});
