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
import type { AleoNetwork, RuntimeImportRef } from "@lionden/config";

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
    /**
     * Pre-normalized runtime-import refs. Seeded into the import resolution
     * graph before the static-import walk, so dynamic-dispatch targets and
     * their transitive deps are bundled into the resulting `imports` map.
     */
    runtimeImports?: readonly RuntimeImportRef[];
  },
): Promise<ProgramExecutionArtifacts> {
  const local = readLocalProgramSource(options.artifactsDir, options.programId);
  const source = local?.source ?? await options.networkClient.getProgram(options.programId);
  const sourceOrigin = local ? "artifact" : "network";
  const imports = await resolveProgramImports({
    artifactsDir: options.artifactsDir,
    programSource: source,
    networkClient: options.networkClient,
    runtimeImports: options.runtimeImports,
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

/**
 * Whether `transition` declares any record-typed input — `{ Record: ... }`
 * (local or external) or the first-class `"DynamicRecord"` — per the program's
 * `abi.json` (a sibling of `main.aleo` in `artifactDir`).
 *
 * Record-consuming transitions need an on-chain inclusion proof. The eager
 * key-synthesis path (`synthesizeKeyPair`) has no query parameter, so for these
 * transitions snarkVM builds that inclusion proof against the SDK's baked-in
 * SnapshotQuery (`https://api.provable.com/v2`) instead of the configured
 * endpoint, bypassing the egress-guarded transport. Callers use this to skip
 * eager synthesis for such transitions.
 *
 * Returns `undefined` when the ABI can't be located, parsed, or trusted to
 * prove the transition is record-free: network-sourced program (no
 * `artifactDir`), missing/garbled `abi.json`, unknown transition, OR any input
 * whose `ty` shape is unrecognized (e.g. a stale/corrupt entry missing `ty`, or
 * a future ABI variant). `false` is returned only when EVERY input is a
 * recognized record-free shape. Callers must treat `undefined` conservatively —
 * skip eager synthesis rather than risk the leak.
 */
export function transitionHasRecordInput(
  artifacts: ProgramExecutionArtifacts,
  transition: string,
): boolean | undefined {
  if (!artifacts.artifactDir) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(artifacts.artifactDir, "abi.json"), "utf-8"));
  } catch {
    return undefined;
  }

  const functions = (parsed as { functions?: unknown }).functions;
  if (!Array.isArray(functions)) return undefined;

  const fn = functions.find(
    (entry): entry is { name?: unknown; inputs?: unknown } =>
      typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === transition,
  );
  if (!fn || !Array.isArray(fn.inputs)) return undefined;

  // Classify every input. A single record/DynamicRecord input makes the
  // transition record-consuming. An unrecognized input shape means the ABI has
  // NOT proven the transition is record-free, so report `undefined` (caller
  // skips eager synthesis). `false` requires every input to be record-free.
  let sawUnknown = false;
  for (const input of fn.inputs) {
    switch (classifyInputType((input as { ty?: unknown })?.ty)) {
      case "record":
        return true;
      case "unknown":
        sawUnknown = true;
        break;
    }
  }
  return sawUnknown ? undefined : false;
}

/**
 * Classify a function-input `ty`. Per the Aleo ABI an input is one of
 * `{ Plaintext }`, `{ Record }`, `{ Future }`, or the string `"DynamicRecord"`.
 * `"record"` covers the two record-consuming shapes (which need an inclusion
 * proof); `"safe"` covers the record-free shapes; anything else — including a
 * missing or non-object `ty` — is `"unknown"` so callers stay conservative.
 */
function classifyInputType(ty: unknown): "record" | "safe" | "unknown" {
  if (ty === "DynamicRecord") return "record";
  if (typeof ty !== "object" || ty === null) return "unknown";
  if ("Record" in ty) return "record";
  if ("Plaintext" in ty || "Future" in ty) return "safe";
  return "unknown";
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
    runtimeImports?: readonly RuntimeImportRef[];
  },
): Promise<Record<string, string> | undefined> {
  const imports = new Map<string, string>();
  // Tracks where each import id was first sourced from, for clear conflict
  // error messages when a duplicate id arrives with different content.
  const origins = new Map<string, string>();

  const addImport = (id: string, source: string, origin: string): void => {
    const existing = imports.get(id);
    if (existing !== undefined) {
      if (existing === source) return;
      const existingOrigin = origins.get(id) ?? "<unknown>";
      throw new Error(
        `Runtime import conflict for program "${id}": same id resolved to two different sources.\n` +
          `  - from ${existingOrigin}: sha256=${sha256Text(existing)}\n` +
          `  - from ${origin}: sha256=${sha256Text(source)}\n` +
          `Reconcile the runtime-import refs so the same program id points at one source.`,
      );
    }
    imports.set(id, source);
    origins.set(id, origin);
  };

  const visit = async (programSource: string, ancestry: Set<string>): Promise<void> => {
    for (const importId of parseImportIds(programSource)) {
      if (imports.has(importId) || ancestry.has(importId)) continue;

      const local = readLocalProgramSource(options.artifactsDir, importId);
      const importSource = local?.source ?? await options.networkClient.getProgram(importId);
      const origin = local ? `static import ← artifacts/${importId}` : `static import ← network`;
      addImport(importId, importSource, origin);

      const nextAncestry = new Set(ancestry);
      nextAncestry.add(importId);
      await visit(importSource, nextAncestry);
    }
  };

  // Seed runtime imports first. The static-import walk below picks up
  // anything they statically import, but we want their own (programId, source)
  // pairs to win for conflict-detection purposes.
  for (const ref of options.runtimeImports ?? []) {
    const seeded = await seedRuntimeImport(ref, options.artifactsDir, options.networkClient);
    addImport(seeded.programId, seeded.source, seeded.origin);
    await visit(seeded.source, new Set([seeded.programId]));
  }

  await visit(options.programSource, new Set());
  if (imports.size === 0) return undefined;

  return Object.fromEntries([...imports.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function seedRuntimeImport(
  ref: RuntimeImportRef,
  artifactsDir: string | undefined,
  networkClient: { getProgram(id: string): Promise<string> },
): Promise<{ programId: string; source: string; origin: string }> {
  if (ref.kind === "path") {
    if (!fs.existsSync(ref.absolutePath)) {
      throw new Error(
        `Runtime import path not found at execute time: ${ref.absolutePath}`,
      );
    }
    const source = fs.readFileSync(ref.absolutePath, "utf-8");
    const programId = parseProgramIdFromSource(source, ref.absolutePath);
    return { programId, source, origin: `runtime import ← ${ref.absolutePath}` };
  }

  const local = readLocalProgramSource(artifactsDir, ref.programId);
  const source = local?.source ?? await networkClient.getProgram(ref.programId);
  const origin = local
    ? `runtime import ← artifacts/${ref.programId}`
    : `runtime import ← network (${ref.programId})`;
  return { programId: ref.programId, source, origin };
}

function parseProgramIdFromSource(source: string, sourcePath: string): string {
  const match = /^\s*program\s+([a-zA-Z_][a-zA-Z0-9_]*\.aleo)\s*;/m.exec(source);
  if (!match) {
    const firstNonEmpty = source.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "<empty>";
    throw new Error(
      `Cannot infer program id from .aleo source at ${sourcePath} — missing \`program <id>.aleo;\` header.\n` +
        `First non-empty line: ${JSON.stringify(firstNonEmpty.slice(0, 120))}`,
    );
  }
  return match[1]!;
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
