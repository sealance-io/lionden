import { describe, it, expect } from "vitest";
import {
  parseConstructor,
  parseConstructorFromFiles,
  isValidAleoAddress,
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
        fn constructor() {
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
        fn constructor() {
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

  it("parses @custom constructor", () => {
    const source = `
      program dao.aleo {
        @custom
        fn constructor() {
          // custom upgrade logic with governance vote
        }
      }
    `;
    const result = parseConstructor(source);
    expect(result).toEqual({ type: "custom" });
  });

  it("handles whitespace between annotation and fn", () => {
    const source = `
      @noupgrade

      fn constructor() {}
    `;
    expect(parseConstructor(source)).toEqual({ type: "noupgrade" });
  });

  it("handles comments between annotation and fn", () => {
    const source = `
      @noupgrade
      // This program cannot be upgraded
      fn constructor() {}
    `;
    expect(parseConstructor(source)).toEqual({ type: "noupgrade" });
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
        fn constructor() {}
      */
      fn main() {}
    `;
    expect(parseConstructor(source)).toBeNull();
  });

  it("parses @admin with spaces in attribute", () => {
    const source = `
      @admin( address = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px" )
      fn constructor() {}
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
      fn constructor() {}

      @custom
      fn constructor() {}
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
    const sources = [
      `@noupgrade\nfn constructor() {}`,
      `fn main() {}`,
    ];
    expect(parseConstructorFromFiles(sources)?.type).toBe("noupgrade");
  });

  it("finds constructor in second file", () => {
    const sources = [
      `fn main() {}`,
      `@custom\nfn constructor() {}`,
    ];
    expect(parseConstructorFromFiles(sources)?.type).toBe("custom");
  });

  it("returns null when no file has constructor", () => {
    const sources = [
      `fn main() {}`,
      `fn helper() {}`,
    ];
    expect(parseConstructorFromFiles(sources)).toBeNull();
  });
});

describe("isValidAleoAddress", () => {
  it("validates correct aleo address", () => {
    expect(
      isValidAleoAddress(
        "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
      ),
    ).toBe(true);
  });

  it("rejects address without aleo1 prefix", () => {
    expect(
      isValidAleoAddress(
        "btc1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
      ),
    ).toBe(false);
  });

  it("rejects address that is too short", () => {
    expect(isValidAleoAddress("aleo1short")).toBe(false);
  });

  it("rejects address with uppercase characters", () => {
    expect(
      isValidAleoAddress(
        "aleo1RHGDU77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
      ),
    ).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidAleoAddress("")).toBe(false);
  });
});
