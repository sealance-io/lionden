import { describe, expect, it } from "vitest";
import {
  extractConstructorFingerprint,
  isValidAleoAddress,
  parseConstructor,
  parseConstructorFromFiles,
} from "./constructor-parser.js";

describe("parseConstructor", () => {
  it("returns null when no constructor is present", () => {
    const source = `
      program hello.aleo {
        fn main(a: u32, b: u32) -> u32 {
          return a + b;
        }
      }
    `;
    expect(parseConstructor(source)).toBeNull();
  });

  it("parses @noupgrade constructor", () => {
    const source = `
      program hello.aleo {
        @noupgrade
        constructor() {
          assert_eq(edition, 0u16);
        }

        fn main(a: u32, b: u32) -> u32 {
          return a + b;
        }
      }
    `;
    const result = parseConstructor(source);
    expect(result).toEqual({ type: "noupgrade" });
  });

  it("parses @admin constructor with address", () => {
    const source = `
      program token.aleo {
        @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
        constructor() {
          // admin-only upgrade logic
        }
      }
    `;
    const result = parseConstructor(source);
    expect(result).toEqual({
      type: "admin",
      adminAddress: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    });
  });

  it("parses @checksum constructor with mapping and key", () => {
    const source = `
      program dao_member.aleo {
        @checksum(mapping="basic_voting.aleo::approved_checksum", key="true")
        constructor() {
          // checksum-governed upgrade
        }
      }
    `;
    const result = parseConstructor(source);
    expect(result).toEqual({
      type: "checksum",
      checksumMapping: "basic_voting.aleo::approved_checksum",
      checksumKey: "true",
    });
  });

  it("parses @checksum with spaces in attribute", () => {
    const source = `
      @checksum( mapping = "gov.aleo::checksums" , key = "dao_member" )
      constructor() {}
    `;
    const result = parseConstructor(source);
    expect(result?.type).toBe("checksum");
    expect(result?.checksumMapping).toBe("gov.aleo::checksums");
    expect(result?.checksumKey).toBe("dao_member");
  });

  it("parses @custom constructor", () => {
    const source = `
      program dao.aleo {
        @custom
        constructor() {
          // custom upgrade logic with governance vote
        }
      }
    `;
    const result = parseConstructor(source);
    expect(result).toEqual({ type: "custom" });
  });

  it("handles whitespace between annotation and constructor", () => {
    const source = `
      @noupgrade

      constructor() {}
    `;
    expect(parseConstructor(source)).toEqual({ type: "noupgrade" });
  });

  it("handles comments between annotation and constructor", () => {
    const source = `
      @noupgrade
      // This program cannot be upgraded
      constructor() {}
    `;
    expect(parseConstructor(source)).toEqual({ type: "noupgrade" });
  });

  // Leo v3.5 uses `async constructor()` syntax (v4 drops the `async` keyword)
  it("parses @noupgrade async constructor (v3.5 syntax)", () => {
    const source = `
      program hello.aleo {
        @noupgrade
        async constructor() {}
      }
    `;
    expect(parseConstructor(source)).toEqual({ type: "noupgrade" });
  });

  it("parses @admin async constructor (v3.5 syntax)", () => {
    const source = `
      program token.aleo {
        @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
        async constructor() {}
      }
    `;
    const result = parseConstructor(source);
    expect(result).toEqual({
      type: "admin",
      adminAddress: "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    });
  });

  it("parses @checksum async constructor (v3.5 syntax)", () => {
    const source = `
      program dao_member.aleo {
        @checksum(mapping="basic_voting.aleo::approved_checksum", key="true")
        async constructor() {}
      }
    `;
    const result = parseConstructor(source);
    expect(result).toEqual({
      type: "checksum",
      checksumMapping: "basic_voting.aleo::approved_checksum",
      checksumKey: "true",
    });
  });

  it("parses @custom async constructor (v3.5 syntax)", () => {
    const source = `
      program dao.aleo {
        @custom
        async constructor() {
          // custom upgrade logic
        }
      }
    `;
    expect(parseConstructor(source)).toEqual({ type: "custom" });
  });

  it("ignores @noupgrade not followed by constructor", () => {
    const source = `
      // @noupgrade
      fn main() {}
    `;
    // This is a line comment — stripped content won't match pattern
    expect(parseConstructor(source)).toBeNull();
  });

  it("ignores constructor annotations inside block comments", () => {
    const source = `
      /*
        @noupgrade
        constructor() {}
      */
      fn main() {}
    `;
    expect(parseConstructor(source)).toBeNull();
  });

  it("parses @admin with spaces in attribute", () => {
    const source = `
      @admin( address = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px" )
      constructor() {}
    `;
    const result = parseConstructor(source);
    expect(result?.type).toBe("admin");
    expect(result?.adminAddress).toBe(
      "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    );
  });

  it("returns first match when multiple constructors present", () => {
    // Should not happen in practice, but test deterministic behavior
    const source = `
      @noupgrade
      constructor() {}

      @custom
      constructor() {}
    `;
    // @admin is tried first, then @noupgrade
    const result = parseConstructor(source);
    expect(result?.type).toBe("noupgrade");
  });
});

describe("parseConstructorFromFiles", () => {
  it("returns null for empty file list", () => {
    expect(parseConstructorFromFiles([])).toBeNull();
  });

  it("finds constructor in first file", () => {
    const sources = [`@noupgrade\nconstructor() {}`, `fn main() {}`];
    expect(parseConstructorFromFiles(sources)?.type).toBe("noupgrade");
  });

  it("finds constructor in second file", () => {
    const sources = [`fn main() {}`, `@custom\nconstructor() {}`];
    expect(parseConstructorFromFiles(sources)?.type).toBe("custom");
  });

  it("returns null when no file has constructor", () => {
    const sources = [`fn main() {}`, `fn helper() {}`];
    expect(parseConstructorFromFiles(sources)).toBeNull();
  });
});

describe("extractConstructorFingerprint", () => {
  it("returns empty string when no constructor section exists", () => {
    const source = `program hello.aleo;\n\nfunction main:\n    output 1u32 as u32.private;\n`;
    expect(extractConstructorFingerprint(source)).toBe("");
  });

  it("returns empty string for edition-only constructor (admin mode)", () => {
    const source = `program hello.aleo;\n\nconstructor:\n    assert.eq edition 0u16;\n`;
    expect(extractConstructorFingerprint(source, "admin")).toBe("");
  });

  it("extracts admin signer assertion (strips edition)", () => {
    const source = [
      "program hello.aleo;",
      "",
      "constructor:",
      "    assert.eq self.signer aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;",
      "    assert.eq edition 0u16;",
      "",
    ].join("\n");
    expect(extractConstructorFingerprint(source, "admin")).toBe(
      "assert.eq self.signer aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px;",
    );
  });

  it("is stable across edition changes for compiler-managed modes", () => {
    const makeSource = (edition: number) =>
      `program test.aleo;\n\nconstructor:\n    assert.eq self.signer aleo1abc;\n    assert.eq edition ${edition}u16;\n`;
    expect(extractConstructorFingerprint(makeSource(0), "admin")).toBe(
      extractConstructorFingerprint(makeSource(5), "admin"),
    );
  });

  it("custom mode preserves edition assertion verbatim", () => {
    const source = [
      "program dao.aleo;",
      "",
      "constructor:",
      "    call governance.aleo/check_vote into r0;",
      "    assert.eq r0 true;",
      "    assert.eq edition 2u16;",
      "",
    ].join("\n");
    const fingerprint = extractConstructorFingerprint(source, "custom");
    // For @custom, edition assertion IS user-authored logic — must be preserved
    expect(fingerprint).toContain("assert.eq edition 2u16;");
    expect(fingerprint).toBe(
      "call governance.aleo/check_vote into r0;\nassert.eq r0 true;\nassert.eq edition 2u16;",
    );
  });

  it("custom mode detects edition assertion change", () => {
    const makeSource = (edition: number) =>
      [
        "program dao.aleo;",
        "",
        "constructor:",
        "    call governance.aleo/check_vote into r0;",
        "    assert.eq edition " + edition + "u16;",
        "",
      ].join("\n");
    // For @custom, different edition values produce different fingerprints
    expect(extractConstructorFingerprint(makeSource(0), "custom")).not.toBe(
      extractConstructorFingerprint(makeSource(1), "custom"),
    );
  });

  it("default (no mode) strips edition for backwards compatibility", () => {
    const source = [
      "program dao.aleo;",
      "",
      "constructor:",
      "    call governance.aleo/check_vote into r0;",
      "    assert.eq r0 true;",
      "    assert.eq edition 2u16;",
      "",
    ].join("\n");
    // Without mode, edition is stripped (backwards-compatible default)
    expect(extractConstructorFingerprint(source)).toBe(
      "call governance.aleo/check_vote into r0;\nassert.eq r0 true;",
    );
  });

  it("checksum mode strips edition assertion", () => {
    const source = [
      "program member.aleo;",
      "",
      "constructor:",
      "    get basic_voting.aleo/approved_checksum[true] into r0;",
      "    assert.eq checksum r0;",
      "    assert.eq edition 0u16;",
      "",
    ].join("\n");
    expect(extractConstructorFingerprint(source, "checksum")).toBe(
      "get basic_voting.aleo/approved_checksum[true] into r0;\nassert.eq checksum r0;",
    );
  });
});

describe("isValidAleoAddress", () => {
  it("validates correct aleo address", () => {
    expect(
      isValidAleoAddress("aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"),
    ).toBe(true);
  });

  it("rejects address without aleo1 prefix", () => {
    expect(
      isValidAleoAddress("btc1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"),
    ).toBe(false);
  });

  it("rejects address that is too short", () => {
    expect(isValidAleoAddress("aleo1short")).toBe(false);
  });

  it("rejects address with uppercase characters", () => {
    expect(
      isValidAleoAddress("aleo1RHGDU77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px"),
    ).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidAleoAddress("")).toBe(false);
  });
});
