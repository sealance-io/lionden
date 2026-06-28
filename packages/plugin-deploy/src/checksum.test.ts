import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeployError } from "./errors.js";
import { formatChecksumLiteral, readCompiledAleoSource } from "./checksum.js";

describe("formatChecksumLiteral", () => {
  it("renders 32 bytes as a Leo [u8; 32] array literal", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 183;
    bytes[1] = 0;
    bytes[31] = 255;
    const literal = formatChecksumLiteral(bytes);
    expect(literal.startsWith("[183u8, 0u8, ")).toBe(true);
    expect(literal.endsWith(", 255u8]")).toBe(true);
    // 32 elements, comma-separated.
    expect(literal.split(",")).toHaveLength(32);
    // Every element is a u8 literal.
    expect(literal.replace(/[[\]]/g, "").split(", ").every((t) => /^\d{1,3}u8$/.test(t))).toBe(true);
  });

  it("throws on a non-32-byte checksum", () => {
    expect(() => formatChecksumLiteral(new Uint8Array(31))).toThrow(DeployError);
    expect(() => formatChecksumLiteral(new Uint8Array(33))).toThrow(/32-byte checksum/);
  });
});

describe("readCompiledAleoSource", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("reads artifacts/<programId>/main.aleo", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "checksum-test-"));
    tmpDirs.push(root);
    const progDir = path.join(root, "hello.aleo");
    fs.mkdirSync(progDir, { recursive: true });
    fs.writeFileSync(path.join(progDir, "main.aleo"), "program hello.aleo;\n");
    expect(readCompiledAleoSource(root, "hello.aleo")).toBe("program hello.aleo;\n");
  });

  it("throws a DeployError when the compiled .aleo is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "checksum-test-"));
    tmpDirs.push(root);
    expect(() => readCompiledAleoSource(root, "missing.aleo")).toThrow(DeployError);
    expect(() => readCompiledAleoSource(root, "missing.aleo")).toThrow(/No compiled \.aleo found/);
  });
});
