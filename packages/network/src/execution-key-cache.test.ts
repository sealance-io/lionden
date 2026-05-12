import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  KEY_ARTIFACTS_FORMAT,
  fingerprintBytes,
  sha256Json,
  sha256Text,
  writeKeyArtifactsMetadata,
} from "@lionden/core";
import {
  buildRuntimeKeyIdentity,
  findCachedExecutionKeys,
  writeCachedExecutionKeys,
  type ProgramExecutionArtifacts,
} from "./execution-key-cache.js";

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-runtime-keys-"));
  cachePath = path.join(tmpDir, ".aleo");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("execution key cache", () => {
  const identity = buildRuntimeKeyIdentity({
    network: "testnet",
    programId: "hello.aleo",
    transition: "main",
    sourceHash: "a".repeat(64),
    importsHash: "b".repeat(64),
    wasmHash: "c".repeat(64),
  });

  it("round-trips runtime cache bytes", () => {
    writeCachedExecutionKeys(
      {
        identity,
        provingKeyBytes: new Uint8Array([1, 2, 3]),
        verifyingKeyBytes: new Uint8Array([4, 5]),
        diagnostics: { sdkVersion: "0.10.5", wasmVersion: "0.10.5" },
      },
      cachePath,
    );

    const hit = findCachedExecutionKeys({ cachePath, identity });
    expect(hit?.source).toBe("runtime");
    expect([...hit!.provingKeyBytes]).toEqual([1, 2, 3]);
    expect([...hit!.verifyingKeyBytes]).toEqual([4, 5]);
  });

  it("misses when the wasm artifact hash changes", () => {
    writeCachedExecutionKeys(
      {
        identity,
        provingKeyBytes: new Uint8Array([1]),
        verifyingKeyBytes: new Uint8Array([2]),
      },
      cachePath,
    );

    const changed = { ...identity, wasmHash: "d".repeat(64) };
    expect(findCachedExecutionKeys({ cachePath, identity: changed })).toBeUndefined();
  });

  it("recovers from corrupted runtime key bytes as a miss", () => {
    writeCachedExecutionKeys(
      {
        identity,
        provingKeyBytes: new Uint8Array([1]),
        verifyingKeyBytes: new Uint8Array([2]),
      },
      cachePath,
    );

    const runtimeRoot = path.join(cachePath, "lionden-runtime");
    const entryDir = path.join(runtimeRoot, fs.readdirSync(runtimeRoot)[0]!);
    fs.writeFileSync(path.join(entryDir, "prover.key"), new Uint8Array([9, 9]));

    expect(findCachedExecutionKeys({ cachePath, identity })).toBeUndefined();
  });

  it("does not include SDK version diagnostics in cache identity", () => {
    writeCachedExecutionKeys(
      {
        identity,
        provingKeyBytes: new Uint8Array([1]),
        verifyingKeyBytes: new Uint8Array([2]),
        diagnostics: { sdkVersion: "0.10.5" },
      },
      cachePath,
    );

    const runtimeRoot = path.join(cachePath, "lionden-runtime");
    const entryDir = path.join(runtimeRoot, fs.readdirSync(runtimeRoot)[0]!);
    const metadataPath = path.join(entryDir, "metadata.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
    metadata["diagnostics"] = { sdkVersion: "0.10.6" };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    expect(findCachedExecutionKeys({ cachePath, identity })).toBeDefined();
  });

  it("prefers valid compiler sidecar refs over runtime cache entries", () => {
    const artifactDir = path.join(tmpDir, "artifacts", "hello.aleo");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "main.prover"), new Uint8Array([7]));
    fs.writeFileSync(path.join(artifactDir, "main.verifier"), new Uint8Array([8]));

    const source = "program hello.aleo {}";
    const artifacts: ProgramExecutionArtifacts = {
      source,
      sourceOrigin: "artifact",
      sourceHash: sha256Text(source),
      importsHash: sha256Json({ imports: [] }),
      artifactDir,
      sidecar: {
        format: KEY_ARTIFACTS_FORMAT,
        programId: "hello.aleo",
        sourceHash: sha256Text(source),
        importsHash: sha256Json({ imports: [] }),
        functions: [{
          transition: "main",
          prover: {
            path: "main.prover",
            fingerprint: fingerprintBytes(new Uint8Array([7])),
          },
          verifier: {
            path: "main.verifier",
            fingerprint: fingerprintBytes(new Uint8Array([8])),
          },
        }],
      },
    };
    writeKeyArtifactsMetadata(
      path.join(artifactDir, "lionden-key-artifacts.json"),
      artifacts.sidecar!,
    );
    writeCachedExecutionKeys(
      {
        identity: { ...identity, sourceHash: artifacts.sourceHash, importsHash: artifacts.importsHash },
        provingKeyBytes: new Uint8Array([1]),
        verifyingKeyBytes: new Uint8Array([2]),
      },
      cachePath,
    );

    const hit = findCachedExecutionKeys({
      cachePath,
      identity: { ...identity, sourceHash: artifacts.sourceHash, importsHash: artifacts.importsHash },
      artifacts,
    });
    expect(hit?.source).toBe("sidecar");
    expect([...hit!.provingKeyBytes]).toEqual([7]);
    expect([...hit!.verifyingKeyBytes]).toEqual([8]);
  });
});
