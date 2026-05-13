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
  resolveProgramExecutionArtifacts,
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

  it("resolves local imports recursively for execution identity", async () => {
    const artifactsDir = path.join(tmpDir, "artifacts");
    const appSource = "import foo.aleo;\nprogram app.aleo;";
    const fooSource = "import bar.aleo;\nprogram foo.aleo;";
    const barSource = "program bar.aleo;";

    for (const [programId, source] of [
      ["app.aleo", appSource],
      ["foo.aleo", fooSource],
      ["bar.aleo", barSource],
    ] as const) {
      const artifactDir = path.join(artifactsDir, programId);
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);
    }

    const artifacts = await resolveProgramExecutionArtifacts({
      artifactsDir,
      programId: "app.aleo",
      networkClient: {
        getProgram: async (programId) => {
          throw new Error(`unexpected network fetch for ${programId}`);
        },
      },
    });

    expect(artifacts.imports).toEqual({
      "bar.aleo": barSource,
      "foo.aleo": fooSource,
    });
    expect(artifacts.importsHash).toBe(sha256Json({
      imports: [
        { programId: "bar.aleo", sourceHash: sha256Text(barSource) },
        { programId: "foo.aleo", sourceHash: sha256Text(fooSource) },
      ],
    }));
  });
});

describe("execution key cache — runtime imports", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lionden-runtime-imports-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("seeds a programId ref from local artifacts", async () => {
    const artifactsDir = path.join(tmpDir, "artifacts");
    const appSource = "program app.aleo;";
    const targetSource = "program voting_power.aleo;";

    for (const [programId, source] of [
      ["app.aleo", appSource],
      ["voting_power.aleo", targetSource],
    ] as const) {
      const artifactDir = path.join(artifactsDir, programId);
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, "main.aleo"), source);
    }

    const artifacts = await resolveProgramExecutionArtifacts({
      artifactsDir,
      programId: "app.aleo",
      networkClient: {
        getProgram: async (id) => {
          throw new Error(`unexpected network fetch for ${id}`);
        },
      },
      runtimeImports: [{ kind: "programId", programId: "voting_power.aleo" }],
    });

    expect(artifacts.imports).toEqual({ "voting_power.aleo": targetSource });
  });

  it("seeds a programId ref via network fetch when not local", async () => {
    const appSource = "program app.aleo;";
    const targetSource = "program voting_power.aleo;";
    const fetched: string[] = [];

    const artifacts = await resolveProgramExecutionArtifacts({
      programId: "app.aleo",
      networkClient: {
        getProgram: async (id) => {
          fetched.push(id);
          if (id === "app.aleo") return appSource;
          if (id === "voting_power.aleo") return targetSource;
          throw new Error(`unexpected: ${id}`);
        },
      },
      runtimeImports: [{ kind: "programId", programId: "voting_power.aleo" }],
    });

    expect(artifacts.imports).toEqual({ "voting_power.aleo": targetSource });
    expect(fetched).toContain("voting_power.aleo");
  });

  it("seeds a path ref by reading the file and inferring the program id", async () => {
    const appSource = "program app.aleo;";
    const targetPath = path.join(tmpDir, "voting_power.aleo");
    const targetSource = "program voting_power.aleo;\n// inline bytecode";
    fs.writeFileSync(targetPath, targetSource);

    const artifacts = await resolveProgramExecutionArtifacts({
      programId: "app.aleo",
      networkClient: {
        getProgram: async (id) => {
          if (id === "app.aleo") return appSource;
          throw new Error(`unexpected network fetch: ${id}`);
        },
      },
      runtimeImports: [{ kind: "path", absolutePath: targetPath }],
    });

    expect(artifacts.imports).toEqual({ "voting_power.aleo": targetSource });
  });

  it("pulls in transitive static imports of runtime targets", async () => {
    const appSource = "program app.aleo;";
    const targetSource = "import helper.aleo;\nprogram voting_power.aleo;";
    const helperSource = "program helper.aleo;";

    const artifacts = await resolveProgramExecutionArtifacts({
      programId: "app.aleo",
      networkClient: {
        getProgram: async (id) => {
          if (id === "app.aleo") return appSource;
          if (id === "voting_power.aleo") return targetSource;
          if (id === "helper.aleo") return helperSource;
          throw new Error(`unexpected: ${id}`);
        },
      },
      runtimeImports: [{ kind: "programId", programId: "voting_power.aleo" }],
    });

    expect(artifacts.imports).toEqual({
      "helper.aleo": helperSource,
      "voting_power.aleo": targetSource,
    });
  });

  it("throws on .aleo header parse failure", async () => {
    const appSource = "program app.aleo;";
    const badPath = path.join(tmpDir, "malformed.aleo");
    fs.writeFileSync(badPath, "// no program header\n");

    await expect(
      resolveProgramExecutionArtifacts({
        programId: "app.aleo",
        networkClient: { getProgram: async () => appSource },
        runtimeImports: [{ kind: "path", absolutePath: badPath }],
      }),
    ).rejects.toThrow(/Cannot infer program id/);
  });

  it("collapses duplicate refs that resolve to identical sources", async () => {
    const appSource = "program app.aleo;";
    const targetSource = "program voting_power.aleo;";
    const targetPath = path.join(tmpDir, "voting_power.aleo");
    fs.writeFileSync(targetPath, targetSource);

    const artifacts = await resolveProgramExecutionArtifacts({
      programId: "app.aleo",
      networkClient: {
        getProgram: async (id) => {
          if (id === "app.aleo") return appSource;
          if (id === "voting_power.aleo") return targetSource;
          throw new Error(`unexpected: ${id}`);
        },
      },
      runtimeImports: [
        { kind: "path", absolutePath: targetPath },
        { kind: "programId", programId: "voting_power.aleo" },
      ],
    });

    expect(Object.keys(artifacts.imports ?? {})).toEqual(["voting_power.aleo"]);
  });

  it("throws when two refs resolve to the same id with different sources", async () => {
    const appSource = "program app.aleo;";
    const localSource = "program voting_power.aleo;\n// local";
    const networkSource = "program voting_power.aleo;\n// upstream";
    const localPath = path.join(tmpDir, "local-voting_power.aleo");
    fs.writeFileSync(localPath, localSource);

    await expect(
      resolveProgramExecutionArtifacts({
        programId: "app.aleo",
        networkClient: {
          getProgram: async (id) => {
            if (id === "app.aleo") return appSource;
            if (id === "voting_power.aleo") return networkSource;
            throw new Error(`unexpected: ${id}`);
          },
        },
        runtimeImports: [
          { kind: "path", absolutePath: localPath },
          { kind: "programId", programId: "voting_power.aleo" },
        ],
      }),
    ).rejects.toThrow(/Runtime import conflict for program "voting_power.aleo"/);
  });
});
