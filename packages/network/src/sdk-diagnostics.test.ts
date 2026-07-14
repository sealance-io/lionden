/**
 * Unit tests for the SDK transport-diagnostics machinery:
 *   - `SdkDiagnostics` ring buffer (record / clear / snapshot / cap).
 *   - `makeNetworkTransport(allowed, violation, diagnostics)` recording of
 *     non-OK responses and thrown fetch / host-block failures.
 *   - `captureSdkCall` enrichment policy (enrich on non-empty sink OR opaque
 *     WASM shape; rethrow otherwise; never double-wrap).
 *   - `pickRelevantFailure` / `isOpaqueWasmError` classification helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNetworkTransport } from "./sdk-adapter.js";
import {
  captureSdkCall,
  isOpaqueWasmError,
  pickRelevantFailure,
  SdkDiagnostics,
  type SdkTransportFailure,
  withSuppressedSdkConsoleNoise,
} from "./sdk-diagnostics.js";
import { SdkExecutionError } from "./types.js";

function failure(url: string, overrides: Partial<SdkTransportFailure> = {}): SdkTransportFailure {
  return { method: "GET", url, status: 500, at: 0, ...overrides };
}

describe("SdkDiagnostics", () => {
  it("records, snapshots, and clears failures", () => {
    const diag = new SdkDiagnostics();
    expect(diag.snapshot()).toEqual([]);

    diag.record(failure("/a"));
    diag.record(failure("/b"));
    expect(diag.snapshot().map((f) => f.url)).toEqual(["/a", "/b"]);

    diag.clear();
    expect(diag.snapshot()).toEqual([]);
  });

  it("returns an immutable copy from snapshot()", () => {
    const diag = new SdkDiagnostics();
    diag.record(failure("/a"));
    const snap = diag.snapshot();
    diag.record(failure("/b"));
    // The earlier snapshot is not retroactively mutated.
    expect(snap.map((f) => f.url)).toEqual(["/a"]);
  });

  it("evicts the oldest entries past the ring cap of 16", () => {
    const diag = new SdkDiagnostics();
    for (let i = 0; i < 20; i++) {
      diag.record(failure(`/u${i}`, { at: i }));
    }
    const snap = diag.snapshot();
    expect(snap).toHaveLength(16);
    // First 4 (u0..u3) evicted; window is u4..u19.
    expect(snap[0]!.url).toBe("/u4");
    expect(snap[15]!.url).toBe("/u19");
  });
});

describe("makeNetworkTransport() with diagnostics", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it("records a non-OK statePaths response with status, statusText and body excerpt", async () => {
    fetchSpy.mockResolvedValue(
      new Response("Commitment '123field' does not exist", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    const diag = new SdkDiagnostics();
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block", diag);

    const res = await transport("http://127.0.0.1:3030/testnet/statePaths?commitments=123field");

    expect(res.status).toBe(500);
    const snap = diag.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      method: "GET",
      status: 500,
      statusText: "Internal Server Error",
      bodyExcerpt: "Commitment '123field' does not exist",
    });
    expect(snap[0]!.url).toContain("/statePaths");
  });

  it("records nothing for an OK response", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    const diag = new SdkDiagnostics();
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block", diag);

    await transport("http://127.0.0.1:3030/testnet/stateRoot/latest");

    expect(diag.snapshot()).toEqual([]);
  });

  it("truncates the recorded body excerpt to 512 chars", async () => {
    fetchSpy.mockResolvedValue(new Response("x".repeat(1000), { status: 500 }));
    const diag = new SdkDiagnostics();
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block", diag);

    await transport("http://127.0.0.1:3030/testnet/statePaths");

    expect(diag.snapshot()[0]!.bodyExcerpt).toHaveLength(512);
  });

  it("records a thrown fetch failure and re-throws", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    const diag = new SdkDiagnostics();
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block", diag);

    await expect(transport("http://127.0.0.1:3030/testnet/statePaths")).rejects.toThrow(
      "fetch failed",
    );
    const snap = diag.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ method: "GET", error: "fetch failed" });
    expect(snap[0]!.url).toContain("/statePaths");
  });

  it("records a blocked host (egress violation) and re-throws without calling fetch", async () => {
    const diag = new SdkDiagnostics();
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block", diag);

    await expect(transport("https://api.provable.com/v2/testnet/statePaths")).rejects.toThrow(
      /blocked SDK network fetch/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(diag.snapshot()[0]).toMatchObject({
      method: "GET",
      error: expect.stringContaining("blocked SDK network fetch"),
    });
  });

  it("forwards the request method into the recorded failure", async () => {
    fetchSpy.mockResolvedValue(new Response("boom", { status: 503 }));
    const diag = new SdkDiagnostics();
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block", diag);

    await transport("http://127.0.0.1:3030/testnet/transaction/broadcast", { method: "post" });

    expect(diag.snapshot()[0]).toMatchObject({ method: "POST", status: 503 });
  });
});

describe("pickRelevantFailure()", () => {
  it("prefers the last statePaths failure", () => {
    const failures = [
      failure("/stateRoot/latest"),
      failure("/statePaths?a"),
      failure("/statePaths?b"),
      failure("/other"),
    ];
    expect(pickRelevantFailure(failures)!.url).toBe("/statePaths?b");
  });

  it("falls back to the last stateRoot failure when no statePaths is present", () => {
    expect(pickRelevantFailure([failure("/a"), failure("/stateRoot/x"), failure("/b")])!.url).toBe(
      "/stateRoot/x",
    );
  });

  it("returns undefined when no state-query failure is present (no arbitrary fallback)", () => {
    // A broadcast / non-state-query failure must NOT be surfaced as a state query.
    expect(pickRelevantFailure([failure("/transaction/broadcast"), failure("/b")])).toBeUndefined();
    expect(pickRelevantFailure([])).toBeUndefined();
  });
});

describe("isOpaqueWasmError()", () => {
  it("treats JS-callback / RuntimeError unreachable / non-Error as opaque", () => {
    expect(isOpaqueWasmError(new Error("JS callback Promise rejected:"))).toBe(true);
    expect(isOpaqueWasmError(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
    const runtime = new Error("unreachable");
    runtime.name = "RuntimeError";
    expect(isOpaqueWasmError(runtime)).toBe(true);
    expect(isOpaqueWasmError({})).toBe(true);
    expect(isOpaqueWasmError("")).toBe(true);
  });

  it("treats descriptive errors and non-empty strings as non-opaque", () => {
    expect(isOpaqueWasmError(new Error("Stack evaluation failed: assertion failed"))).toBe(false);
    expect(isOpaqueWasmError(new Error("Network unreachable"))).toBe(false);
    expect(isOpaqueWasmError(new Error("unreachable executed"))).toBe(false);
    const networkRuntime = new Error("Network unreachable");
    networkRuntime.name = "RuntimeError";
    expect(isOpaqueWasmError(networkRuntime)).toBe(false);
    expect(isOpaqueWasmError("connection refused")).toBe(false);
  });
});

describe("captureSdkCall()", () => {
  const editionFallbackMessage =
    "Error finding edition/amendment for hello.aleo. Network response: 'Error fetching amendment count for hello.aleo: Error: 404 Not Found'. Defaulting to edition 1, amendment 0.";

  it("returns the result on success and clears the sink at entry", async () => {
    const diag = new SdkDiagnostics();
    diag.record(failure("/stale")); // pre-existing failure from an earlier read
    const result = await captureSdkCall(
      diag,
      { operation: "execute", programId: "p.aleo", transitionName: "t" },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(diag.snapshot()).toEqual([]);
  });

  it("suppresses reviewed SDK edition/amendment fallback console output while running the SDK call", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const diag = new SdkDiagnostics();
    try {
      await captureSdkCall(diag, { operation: "deploy", programId: "hello.aleo" }, async () => {
        console.log(editionFallbackMessage);
        return "ok";
      });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("enriches an opaque throw with the recorded statePaths failure", async () => {
    const diag = new SdkDiagnostics();
    diag.record(failure("/stale-before-clear")); // must be erased by clear-at-entry
    const original = new Error("JS callback Promise rejected:");

    let thrown: unknown;
    try {
      await captureSdkCall(
        diag,
        { operation: "execute", programId: "token_router.aleo", transitionName: "route_transfer" },
        async () => {
          diag.record(
            failure("http://127.0.0.1:3030/testnet/statePaths?commitments=123field", {
              statusText: "Internal Server Error",
              bodyExcerpt: "Commitment '123field' does not exist",
            }),
          );
          throw original;
        },
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(SdkExecutionError);
    const err = thrown as SdkExecutionError;
    expect(err.kind).toBe("SdkExecutionError");
    expect(err.message).toContain("token_router.aleo/route_transfer");
    expect(err.message).toContain("/statePaths");
    expect(err.message).toContain("500");
    expect(err.message).toContain("does not exist");
    expect(err.cause).toBe(original);
    expect(err.operation).toBe("execute");
    expect(err.programId).toBe("token_router.aleo");
    expect(err.transitionName).toBe("route_transfer");
    // Only the fresh failure survives the clear-at-entry — stale entry is gone.
    expect(err.diagnostics).toHaveLength(1);
    expect(err.diagnostics[0]!.url).toContain("/statePaths");
  });

  it("rethrows unchanged when the sink is empty and the error is descriptive", async () => {
    const diag = new SdkDiagnostics();
    const original = new Error("Stack evaluation failed: assertion failed");
    await expect(
      captureSdkCall(diag, { operation: "local", programId: "p.aleo", transitionName: "t" }, () =>
        Promise.reject(original),
      ),
    ).rejects.toBe(original);
  });

  it("rethrows network unreachable failures unchanged when no state query failed", async () => {
    const diag = new SdkDiagnostics();
    const original = new Error("Network unreachable");
    await expect(
      captureSdkCall(
        diag,
        { operation: "execute", programId: "token.aleo", transitionName: "transfer" },
        async () => {
          diag.record(
            failure("http://127.0.0.1:3030/testnet/transaction/broadcast", {
              method: "POST",
              error: "Network unreachable",
            }),
          );
          throw original;
        },
      ),
    ).rejects.toBe(original);
  });

  it("wraps an opaque WASM abort even when the sink is empty", async () => {
    const diag = new SdkDiagnostics();
    let thrown: unknown;
    try {
      await captureSdkCall(
        diag,
        { operation: "execute", programId: "p.aleo", transitionName: "t" },
        async () => {
          throw new Error("JS callback Promise rejected:");
        },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SdkExecutionError);
    const err = thrown as SdkExecutionError;
    expect(err.message).toContain("WASM aborted without a descriptive error");
    expect(err.diagnostics).toEqual([]);
  });

  it("does not double-wrap an existing SdkExecutionError", async () => {
    const diag = new SdkDiagnostics();
    const inner = new SdkExecutionError("inner", {
      operation: "execute",
      programId: "p.aleo",
      diagnostics: [],
    });
    await expect(
      captureSdkCall(diag, { operation: "execute", programId: "p.aleo" }, () =>
        Promise.reject(inner),
      ),
    ).rejects.toBe(inner);
  });

  it("omits the transition name in the message for deploy/upgrade operations", async () => {
    const diag = new SdkDiagnostics();
    let thrown: unknown;
    try {
      await captureSdkCall(diag, { operation: "deploy", programId: "token.aleo" }, async () => {
        diag.record(failure("/testnet/statePaths", { bodyExcerpt: "nope" }));
        throw new Error("JS callback Promise rejected:");
      });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as SdkExecutionError;
    expect(err.message).toContain("token.aleo deploy failed");
    expect(err.transitionName).toBeUndefined();
  });

  it("rethrows a broadcast (non-state-query) failure with a descriptive error unchanged", async () => {
    const diag = new SdkDiagnostics();
    const original = new Error("Transaction broadcast rejected: invalid fee");
    await expect(
      captureSdkCall(
        diag,
        { operation: "execute", programId: "token.aleo", transitionName: "transfer" },
        async () => {
          // pm.execute() builds+proves THEN broadcasts; a broadcast 400 is
          // recorded by the transport but must not be relabeled as a state query.
          diag.record(
            failure("http://127.0.0.1:3030/testnet/transaction/broadcast", {
              method: "POST",
              status: 400,
              statusText: "Bad Request",
              bodyExcerpt: "invalid fee",
            }),
          );
          throw original;
        },
      ),
    ).rejects.toBe(original);
  });

  it("serializes overlapping calls on a shared sink so failures are not crossed", async () => {
    const diag = new SdkDiagnostics();
    let releaseA!: () => void;
    const aCanFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // Call A acquires the sink, records its own statePaths failure, then blocks.
    const callA = captureSdkCall(
      diag,
      { operation: "execute", programId: "a.aleo", transitionName: "ta" },
      async () => {
        diag.record(failure("http://127.0.0.1:3030/testnet/statePaths?commitments=AAA"));
        await aCanFinish;
        throw new Error("JS callback Promise rejected:");
      },
    );

    // Call B is started while A still holds the sink. It must queue: its fn
    // (and its clear()) must not run until A releases.
    const callB = captureSdkCall(
      diag,
      { operation: "execute", programId: "b.aleo", transitionName: "tb" },
      async () => {
        diag.record(failure("http://127.0.0.1:3030/testnet/statePaths?commitments=BBB"));
        throw new Error("JS callback Promise rejected:");
      },
    );

    releaseA();
    const [aRes, bRes] = await Promise.allSettled([callA, callB]);

    expect(aRes.status).toBe("rejected");
    expect(bRes.status).toBe("rejected");
    const aErr = (aRes as PromiseRejectedResult).reason as SdkExecutionError;
    const bErr = (bRes as PromiseRejectedResult).reason as SdkExecutionError;
    // Each call surfaces only its own commitment — no cross-contamination.
    expect(aErr.programId).toBe("a.aleo");
    expect(aErr.message).toContain("commitments=AAA");
    expect(aErr.diagnostics).toHaveLength(1);
    expect(bErr.programId).toBe("b.aleo");
    expect(bErr.message).toContain("commitments=BBB");
    expect(bErr.diagnostics).toHaveLength(1);
  });
});

describe("withSuppressedSdkConsoleNoise()", () => {
  const editionFallbackMessage =
    "Error finding edition/amendment for hello.aleo. Network response: 'Error fetching amendment count for hello.aleo: Error: 404 Not Found'. Defaulting to edition 1, amendment 0.";

  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it("suppresses the exact edition/amendment fallback message on console log, warn, and error", async () => {
    const logSpy = vi.mocked(console.log);
    const warnSpy = vi.mocked(console.warn);
    const errorSpy = vi.mocked(console.error);

    await withSuppressedSdkConsoleNoise(async () => {
      console.log(editionFallbackMessage);
      console.warn(editionFallbackMessage);
      console.error(editionFallbackMessage);
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not suppress unrelated errors or broader edition/amendment messages", async () => {
    const logSpy = vi.mocked(console.log);
    const warnSpy = vi.mocked(console.warn);

    await withSuppressedSdkConsoleNoise(async () => {
      console.log("Error: deployment failed");
      console.warn("Error finding edition/amendment for hello.aleo.");
    });

    expect(logSpy).toHaveBeenCalledWith("Error: deployment failed");
    expect(warnSpy).toHaveBeenCalledWith("Error finding edition/amendment for hello.aleo.");
  });

  it("restores console methods after a successful wrapped call", async () => {
    const installedLog = console.log;

    await withSuppressedSdkConsoleNoise(async () => {
      expect(console.log).not.toBe(installedLog);
      console.log(editionFallbackMessage);
    });

    expect(console.log).toBe(installedLog);
  });

  it("restores console methods after nested wrapped calls and thrown errors", async () => {
    const installedLog = console.log;
    const installedWarn = console.warn;
    const installedError = console.error;
    const thrown = new Error("boom");

    await expect(
      withSuppressedSdkConsoleNoise(async () => {
        await withSuppressedSdkConsoleNoise(async () => {
          console.error(editionFallbackMessage);
          throw thrown;
        });
      }),
    ).rejects.toBe(thrown);

    expect(console.log).toBe(installedLog);
    expect(console.warn).toBe(installedWarn);
    expect(console.error).toBe(installedError);
  });
});
