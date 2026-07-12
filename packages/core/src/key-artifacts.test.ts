import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fingerprintBytes,
  KEY_ARTIFACTS_FORMAT,
  KeyArtifactsMetadataError,
  readKeyArtifactsMetadata,
  verifyKeyFileRef,
  writeKeyArtifactsMetadata,
} from "./key-artifacts.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-key-artifacts-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("key artifact metadata", () => {
  it("round-trips identity-only compiler sidecars", () => {
    const filePath = path.join(tmpDir, "lionden-key-artifacts.json");
    writeKeyArtifactsMetadata(filePath, {
      format: KEY_ARTIFACTS_FORMAT,
      programId: "hello.aleo",
      sourceProgramId: "hello.aleo",
      sourceHash: "a".repeat(64),
      importsHash: "b".repeat(64),
    });

    expect(readKeyArtifactsMetadata(filePath)).toEqual({
      format: KEY_ARTIFACTS_FORMAT,
      programId: "hello.aleo",
      sourceProgramId: "hello.aleo",
      sourceHash: "a".repeat(64),
      importsHash: "b".repeat(64),
    });
  });

  it("rejects unsupported sidecar formats", () => {
    const filePath = path.join(tmpDir, "lionden-key-artifacts.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        format: "lionden.keyArtifacts.v0",
        programId: "hello.aleo",
        sourceHash: "a".repeat(64),
        importsHash: "b".repeat(64),
      }),
    );

    expect(() => readKeyArtifactsMetadata(filePath)).toThrow(KeyArtifactsMetadataError);
  });

  it("requires sourceProgramId", () => {
    const filePath = path.join(tmpDir, "lionden-key-artifacts.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        format: KEY_ARTIFACTS_FORMAT,
        programId: "hello.aleo",
        sourceHash: "a".repeat(64),
        importsHash: "b".repeat(64),
      }),
    );

    expect(() => readKeyArtifactsMetadata(filePath)).toThrow(/sourceProgramId/);
  });

  it("verifies key file fingerprints", () => {
    const keyPath = path.join(tmpDir, "main.prover");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    fs.writeFileSync(keyPath, bytes);

    const ref = { path: "main.prover", fingerprint: fingerprintBytes(bytes) };
    expect(verifyKeyFileRef(tmpDir, ref)).toBe(true);

    fs.writeFileSync(keyPath, new Uint8Array([9, 9]));
    expect(verifyKeyFileRef(tmpDir, ref)).toBe(false);
  });
});
