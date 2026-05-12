import * as fs from "node:fs";
import * as path from "node:path";
import {
  fingerprintsEqual,
  fingerprintBytes,
  keyArtifactsMetadataPath,
  readKeyArtifactsMetadata,
  readRuntimeKeyCacheMetadata,
  resolveKeyFileRef,
  sha256Json,
  sha256Text,
  verifyKeyFileRef,
  writeRuntimeKeyCacheMetadata,
  type KeyArtifactsMetadata,
  type RuntimeKeyCacheDiagnostics,
  type RuntimeKeyIdentity,
} from "@lionden/core";
import type { AleoNetwork } from "@lionden/config";

export interface ProgramExecutionArtifacts {
  readonly source: string;
  readonly sourceOrigin: "artifact" | "network";
  readonly sourceHash: string;
  readonly imports?: Record<string, string>;
  readonly importsHash: string;
  readonly artifactDir?: string;
  readonly sidecar?: KeyArtifactsMetadata;
}

export interface RuntimeKeyCacheHit {
  readonly source: "sidecar" | "runtime";
  readonly provingKeyBytes: Uint8Array;
  readonly verifyingKeyBytes: Uint8Array;
}

export interface RuntimeKeyCacheWrite {
  readonly identity: RuntimeKeyIdentity;
  readonly provingKeyBytes: Uint8Array;
  readonly verifyingKeyBytes: Uint8Array;
  readonly diagnostics?: RuntimeKeyCacheDiagnostics;
}

export async function resolveProgramExecutionArtifacts(
  options: {
    artifactsDir?: string;
    programId: string;
    networkClient: { getProgram(id: string): Promise<string> };
    includeSidecar?: boolean;
  },
): Promise<ProgramExecutionArtifacts> {
  const local = readLocalProgramSource(options.artifactsDir, options.programId);
  const source = local?.source ?? await options.networkClient.getProgram(options.programId);
  const sourceOrigin = local ? "artifact" : "network";
  const imports = await resolveProgramImports({
    artifactsDir: options.artifactsDir,
    programSource: source,
    networkClient: options.networkClient,
  });
  const artifactDir = local?.artifactDir;
  const sidecarPath = options.includeSidecar && options.artifactsDir
    ? keyArtifactsMetadataPath(options.artifactsDir, options.programId)
    : undefined;
  const sidecar = sidecarPath ? readKeyArtifactsMetadata(sidecarPath) : undefined;

  return {
    source,
    sourceOrigin,
    sourceHash: sha256Text(source),
    imports,
    importsHash: hashImports(imports),
    ...(artifactDir === undefined ? {} : { artifactDir }),
    ...(sidecar === undefined ? {} : { sidecar }),
  };
}

export function findCachedExecutionKeys(
  options: {
    cachePath: string;
    identity: RuntimeKeyIdentity;
    artifacts?: ProgramExecutionArtifacts;
  },
): RuntimeKeyCacheHit | undefined {
  const sidecarHit = readSidecarKeys(options.artifacts, options.identity.transition);
  if (sidecarHit) return sidecarHit;

  const dir = runtimeIdentityDir(options.cachePath, options.identity);
  let metadata;
  try {
    metadata = readRuntimeKeyCacheMetadata(path.join(dir, "metadata.json"));
  } catch {
    return undefined;
  }
  if (!metadata) return undefined;
  if (!runtimeIdentitiesEqual(metadata.identity, options.identity)) return undefined;

  const proverPath = path.join(dir, "prover.key");
  const verifierPath = path.join(dir, "verifier.key");
  if (!fs.existsSync(proverPath) || !fs.existsSync(verifierPath)) return undefined;

  const provingKeyBytes = fs.readFileSync(proverPath);
  const verifyingKeyBytes = fs.readFileSync(verifierPath);
  if (!fingerprintsEqual(fingerprintBytes(provingKeyBytes), metadata.prover)) {
    return undefined;
  }
  if (!fingerprintsEqual(fingerprintBytes(verifyingKeyBytes), metadata.verifier)) {
    return undefined;
  }

  return { source: "runtime", provingKeyBytes, verifyingKeyBytes };
}

export function writeCachedExecutionKeys(write: RuntimeKeyCacheWrite, cachePath: string): void {
  const dir = runtimeIdentityDir(cachePath, write.identity);
  fs.mkdirSync(dir, { recursive: true });

  writeFileAtomic(path.join(dir, "prover.key"), write.provingKeyBytes);
  writeFileAtomic(path.join(dir, "verifier.key"), write.verifyingKeyBytes);
  writeRuntimeKeyCacheMetadata(path.join(dir, "metadata.json"), {
    format: "lionden.runtimeKeyCache.v1",
    identity: write.identity,
    prover: fingerprintBytes(write.provingKeyBytes),
    verifier: fingerprintBytes(write.verifyingKeyBytes),
    ...(write.diagnostics === undefined ? {} : { diagnostics: write.diagnostics }),
  });
}

export function buildRuntimeKeyIdentity(
  options: {
    network: AleoNetwork;
    programId: string;
    transition: string;
    edition?: number;
    sourceHash: string;
    importsHash: string;
    wasmHash: string;
  },
): RuntimeKeyIdentity {
  return {
    network: options.network,
    programId: options.programId,
    transition: options.transition,
    ...(options.edition === undefined ? {} : { edition: options.edition }),
    sourceHash: options.sourceHash,
    importsHash: options.importsHash,
    wasmHash: options.wasmHash,
  };
}

function readSidecarKeys(
  artifacts: ProgramExecutionArtifacts | undefined,
  transition: string,
): RuntimeKeyCacheHit | undefined {
  if (!artifacts?.sidecar || !artifacts.artifactDir) return undefined;
  if (artifacts.sidecar.sourceHash !== artifacts.sourceHash) return undefined;
  if (artifacts.sidecar.importsHash !== artifacts.importsHash) return undefined;

  const entry = artifacts.sidecar.functions?.find((fn) => fn.transition === transition);
  if (!entry?.prover || !entry.verifier) return undefined;
  if (!verifyKeyFileRef(artifacts.artifactDir, entry.prover)) return undefined;
  if (!verifyKeyFileRef(artifacts.artifactDir, entry.verifier)) return undefined;

  return {
    source: "sidecar",
    provingKeyBytes: fs.readFileSync(resolveKeyFileRef(artifacts.artifactDir, entry.prover)),
    verifyingKeyBytes: fs.readFileSync(resolveKeyFileRef(artifacts.artifactDir, entry.verifier)),
  };
}

function runtimeIdentityDir(cachePath: string, identity: RuntimeKeyIdentity): string {
  return path.join(cachePath, "lionden-runtime", sha256Json(identity));
}

function runtimeIdentitiesEqual(a: RuntimeKeyIdentity, b: RuntimeKeyIdentity): boolean {
  return (
    a.network === b.network &&
    a.programId === b.programId &&
    a.transition === b.transition &&
    a.edition === b.edition &&
    a.sourceHash === b.sourceHash &&
    a.importsHash === b.importsHash &&
    a.wasmHash === b.wasmHash
  );
}

function readLocalProgramSource(
  artifactsDir: string | undefined,
  programId: string,
): { source: string; artifactDir: string } | undefined {
  if (!artifactsDir) return undefined;
  const artifactDir = path.join(artifactsDir, programId);
  const sourcePath = path.join(artifactDir, "main.aleo");
  if (!fs.existsSync(sourcePath)) return undefined;
  return { source: fs.readFileSync(sourcePath, "utf-8"), artifactDir };
}

async function resolveProgramImports(
  options: {
    artifactsDir?: string;
    programSource: string;
    networkClient: { getProgram(id: string): Promise<string> };
  },
): Promise<Record<string, string> | undefined> {
  const imports = new Map<string, string>();

  const visit = async (programSource: string, ancestry: Set<string>): Promise<void> => {
    for (const importId of parseImportIds(programSource)) {
      if (imports.has(importId) || ancestry.has(importId)) continue;

      const local = readLocalProgramSource(options.artifactsDir, importId);
      const importSource = local?.source ?? await options.networkClient.getProgram(importId);
      imports.set(importId, importSource);

      const nextAncestry = new Set(ancestry);
      nextAncestry.add(importId);
      await visit(importSource, nextAncestry);
    }
  };

  await visit(options.programSource, new Set());
  if (imports.size === 0) return undefined;

  return Object.fromEntries([...imports.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function parseImportIds(programSource: string): string[] {
  const importPattern = /import\s+([\w]+\.aleo)\s*;/g;
  const ids = new Set<string>();
  let match;
  while ((match = importPattern.exec(programSource)) !== null) {
    ids.add(match[1]!);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function hashImports(imports: Record<string, string> | undefined): string {
  if (!imports) return sha256Json({ imports: [] });
  return sha256Json({
    imports: Object.entries(imports)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([programId, source]) => ({
        programId,
        sourceHash: sha256Text(source),
      })),
  });
}

function writeFileAtomic(filePath: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  fs.writeFileSync(tmpPath, bytes);
  fs.renameSync(tmpPath, filePath);
}
