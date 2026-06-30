import { createMockConnection } from "@lionden/test-internals";
import { describe, expect, it, vi } from "vitest";
import { checkProgramOnChain, createDegradedRecord, fetchImportSources } from "./on-chain-check.js";

// ---------------------------------------------------------------------------
// Sample Aleo source
// ---------------------------------------------------------------------------

const SAMPLE_SOURCE = `
program hello.aleo;

mapping account: address => u64;

function transfer_public:
    input r0 as address.public;
    input r1 as u64.public;
    async transfer_public r0 r1 into r2;
    output r2 as hello.aleo/transfer_public.future;

finalize transfer_public:
    input r0 as address.public;
    input r1 as u64.public;
    get.or_use account[r0] 0u64 into r2;
    sub r2 r1 into r3;
    set r3 into account[r0];

constructor:
    assert.eq edition 3u16;
`;

// ---------------------------------------------------------------------------
// checkProgramOnChain
// ---------------------------------------------------------------------------

describe("checkProgramOnChain", () => {
  it("returns exists=true with source when program is on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(SAMPLE_SOURCE),
    });
    const result = await checkProgramOnChain(conn, "hello.aleo");
    expect(result.exists).toBe(true);
    expect(result.source).toBe(SAMPLE_SOURCE);
  });

  it("returns exists=false with null source when program is not on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const result = await checkProgramOnChain(conn, "missing.aleo");
    expect(result.exists).toBe(false);
    expect(result.source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createDegradedRecord
// ---------------------------------------------------------------------------

describe("createDegradedRecord", () => {
  it("creates a degraded record with correct fields", () => {
    const record = createDegradedRecord(
      "hello.aleo",
      "devnode",
      "http://127.0.0.1:3030",
      SAMPLE_SOURCE,
    );
    expect(record.status).toBe("degraded");
    expect(record.programId).toBe("hello.aleo");
    expect(record.network).toBe("devnode");
    expect(record.endpoint).toBe("http://127.0.0.1:3030");
    expect(record.txId).toBeNull();
    expect(record.blockHeight).toBeNull();
    expect(record.deployerAddress).toBeNull();
    expect(record.deployedAt).toBeNull();
    expect(record.feePaid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchImportSources
// ---------------------------------------------------------------------------

describe("fetchImportSources", () => {
  it("returns a map of programId -> source for found programs", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockImplementation(async (id: string) => {
        if (id === "credits.aleo") return "program credits.aleo;";
        if (id === "other.aleo") return "program other.aleo;";
        return null;
      }),
    });
    const map = await fetchImportSources(conn, ["credits.aleo", "other.aleo"]);
    expect(map.size).toBe(2);
    expect(map.get("credits.aleo")).toBe("program credits.aleo;");
    expect(map.get("other.aleo")).toBe("program other.aleo;");
  });

  it("omits missing programs from the map", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockImplementation(async (id: string) => {
        if (id === "credits.aleo") return "program credits.aleo;";
        return null;
      }),
    });
    const map = await fetchImportSources(conn, ["credits.aleo", "missing.aleo"]);
    expect(map.size).toBe(1);
    expect(map.has("missing.aleo")).toBe(false);
  });

  it("returns empty map for empty input", async () => {
    const conn = createMockConnection();
    const map = await fetchImportSources(conn, []);
    expect(map.size).toBe(0);
  });
});
