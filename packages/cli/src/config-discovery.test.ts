import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findConfigFile } from "./config-discovery.js";

describe("findConfigFile", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("finds lionden.config.ts in start directory", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-test-"));
    const configPath = path.join(tmpDir, "lionden.config.ts");
    fs.writeFileSync(configPath, "export default {};\n");

    expect(findConfigFile(tmpDir)).toBe(configPath);
  });

  it("finds lionden.config.js variant", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-test-"));
    const configPath = path.join(tmpDir, "lionden.config.js");
    fs.writeFileSync(configPath, "export default {};\n");

    expect(findConfigFile(tmpDir)).toBe(configPath);
  });

  it("finds lionden.config.mjs variant", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-test-"));
    const configPath = path.join(tmpDir, "lionden.config.mjs");
    fs.writeFileSync(configPath, "export default {};\n");

    expect(findConfigFile(tmpDir)).toBe(configPath);
  });

  it("prefers .ts over .js when both exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-test-"));
    fs.writeFileSync(path.join(tmpDir, "lionden.config.ts"), "export default {};\n");
    fs.writeFileSync(path.join(tmpDir, "lionden.config.js"), "export default {};\n");

    expect(findConfigFile(tmpDir)).toBe(path.join(tmpDir, "lionden.config.ts"));
  });

  it("walks up to parent directory", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-test-"));
    const child = path.join(tmpDir, "packages", "core");
    fs.mkdirSync(child, { recursive: true });
    const configPath = path.join(tmpDir, "lionden.config.ts");
    fs.writeFileSync(configPath, "export default {};\n");

    expect(findConfigFile(child)).toBe(configPath);
  });

  it("returns null when no config exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-test-"));

    expect(findConfigFile(tmpDir)).toBeNull();
  });
});
