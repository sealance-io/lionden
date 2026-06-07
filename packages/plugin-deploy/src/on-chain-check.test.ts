import { createMockConnection } from "@lionden/test-internals";
import { describe, expect, it, vi } from "vitest";
import {
  checkProgramOnChain,
  createDegradedRecord,
  fetchImportSources,
  parseEditionFromSource,
} from "./on-chain-check.js";

// ---------------------------------------------------------------------------
// Sample Aleo source with constructor
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

const SOURCE_NO_CONSTRUCTOR = `
program bare.aleo;

function main:
    input r0 as u32.public;
    output r0 as u32.public;
`;

const ADMIN_CONSTRUCTOR_NO_EDITION_SOURCE = `
program admin_only.aleo;

constructor:
    assert.eq program_owner aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;
`;

// ---------------------------------------------------------------------------
// checkProgramOnChain
// ---------------------------------------------------------------------------

describe("checkProgramOnChain", () => {
  it("returns exists=true with edition and source when program is on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(SAMPLE_SOURCE),
    });
    const result = await checkProgramOnChain(conn, "hello.aleo");
    expect(result.exists).toBe(true);
    expect(result.edition).toBe(3);
    expect(result.source).toBe(SAMPLE_SOURCE);
  });

  it("returns exists=false with nulls when program is not on-chain", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(null),
    });
    const result = await checkProgramOnChain(conn, "missing.aleo");
    expect(result.exists).toBe(false);
    expect(result.edition).toBeNull();
    expect(result.source).toBeNull();
  });

  it("returns null edition when source has no constructor block", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(SOURCE_NO_CONSTRUCTOR),
    });
    const result = await checkProgramOnChain(conn, "bare.aleo");
    expect(result.exists).toBe(true);
    expect(result.edition).toBeNull();
  });

  it("returns exists=true with null edition for @admin source without edition assertion", async () => {
    const conn = createMockConnection({
      getProgramSource: vi.fn().mockResolvedValue(ADMIN_CONSTRUCTOR_NO_EDITION_SOURCE),
    });
    const result = await checkProgramOnChain(conn, "admin_only.aleo");
    expect(result).toEqual({
      exists: true,
      edition: null,
      source: ADMIN_CONSTRUCTOR_NO_EDITION_SOURCE,
    });
  });
});

// ---------------------------------------------------------------------------
// parseEditionFromSource
// ---------------------------------------------------------------------------

describe("parseEditionFromSource", () => {
  it("parses edition from constructor block", () => {
    expect(parseEditionFromSource(SAMPLE_SOURCE)).toBe(3);
  });

  it("returns null when no edition assertion", () => {
    expect(parseEditionFromSource(SOURCE_NO_CONSTRUCTOR)).toBeNull();
  });

  it("returns null for @admin source without edition assertion", () => {
    expect(parseEditionFromSource(ADMIN_CONSTRUCTOR_NO_EDITION_SOURCE)).toBeNull();
  });

  it("parses edition 0", () => {
    const source = `constructor:\n    assert.eq edition 0u16;\n`;
    expect(parseEditionFromSource(source)).toBe(0);
  });

  it("parses large edition numbers", () => {
    const source = `constructor:\n    assert.eq edition 99u16;\n`;
    expect(parseEditionFromSource(source)).toBe(99);
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
    expect(record.edition).toBe(3);
    expect(record.network).toBe("devnode");
    expect(record.endpoint).toBe("http://127.0.0.1:3030");
    expect(record.constructor.type).toBeNull();
    expect(record.abiHash).toBeNull();
    expect(record.txId).toBeNull();
    expect(record.blockHeight).toBeNull();
    expect(record.deployerAddress).toBeNull();
    expect(record.deployedAt).toBeNull();
    expect(record.feePaid).toBeNull();
  });

  it("uses edition 0 when source has no edition assertion", () => {
    const record = createDegradedRecord(
      "bare.aleo",
      "devnode",
      "http://127.0.0.1:3030",
      SOURCE_NO_CONSTRUCTOR,
    );
    expect(record.edition).toBe(0);
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
