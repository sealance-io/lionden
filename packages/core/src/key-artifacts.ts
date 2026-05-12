import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const KEY_ARTIFACTS_FORMAT = "lionden.keyArtifacts.v1";
export const RUNTIME_KEY_CACHE_FORMAT = "lionden.runtimeKeyCache.v1";

export interface KeyFingerprint {
  readonly sha256: string;
  readonly size: number;
}

export interface KeyFileRef {
  readonly path: string;
  readonly fingerprint: KeyFingerprint;
}

export interface KeyArtifactFunctionRef {
  readonly transition: string;
  readonly prover?: KeyFileRef;
  readonly verifier?: KeyFileRef;
}

export interface KeyArtifactsMetadata {
  readonly format: typeof KEY_ARTIFACTS_FORMAT;
  readonly programId: string;
  readonly sourceHash: string;
  readonly importsHash: string;
  readonly functions?: readonly KeyArtifactFunctionRef[];
}

export interface RuntimeKeyIdentity {
  readonly network: string;
  readonly programId: string;
  readonly transition: string;
  readonly edition?: number;
  readonly sourceHash: string;
  readonly importsHash: string;
  readonly wasmHash: string;
}

export interface RuntimeKeyCacheDiagnostics {
  readonly sdkVersion?: string;
  readonly wasmVersion?: string;
}

export interface RuntimeKeyCacheMetadata {
  readonly format: typeof RUNTIME_KEY_CACHE_FORMAT;
  readonly identity: RuntimeKeyIdentity;
  readonly prover: KeyFingerprint;
  readonly verifier: KeyFingerprint;
  readonly diagnostics?: RuntimeKeyCacheDiagnostics;
}

export class KeyArtifactsMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyArtifactsMetadataError";
  }
}

export function keyArtifactsMetadataPath(
  artifactsDir: string,
  programId: string,
): string {
  return path.join(artifactsDir, programId, "lionden-key-artifacts.json");
}

export function readKeyArtifactsMetadata(
  filePath: string,
): KeyArtifactsMetadata | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return parseKeyArtifactsMetadata(readJson(filePath), filePath);
}

export function writeKeyArtifactsMetadata(
  filePath: string,
  metadata: KeyArtifactsMetadata,
): void {
  parseKeyArtifactsMetadata(metadata, filePath);
  writeJsonAtomic(filePath, metadata);
}

export function readRuntimeKeyCacheMetadata(
  filePath: string,
): RuntimeKeyCacheMetadata | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return parseRuntimeKeyCacheMetadata(readJson(filePath), filePath);
}

export function writeRuntimeKeyCacheMetadata(
  filePath: string,
  metadata: RuntimeKeyCacheMetadata,
): void {
  parseRuntimeKeyCacheMetadata(metadata, filePath);
  writeJsonAtomic(filePath, metadata);
}

export function fingerprintBytes(bytes: Uint8Array): KeyFingerprint {
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

export function fingerprintFile(filePath: string): KeyFingerprint {
  return fingerprintBytes(fs.readFileSync(filePath));
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

export function verifyKeyFileRef(baseDir: string, ref: KeyFileRef): boolean {
  const filePath = resolveKeyFileRef(baseDir, ref);
  if (!fs.existsSync(filePath)) return false;
  return fingerprintsEqual(fingerprintFile(filePath), ref.fingerprint);
}

export function resolveKeyFileRef(baseDir: string, ref: KeyFileRef): string {
  if (path.isAbsolute(ref.path)) {
    throw new KeyArtifactsMetadataError("Key file references must be relative paths.");
  }
  const resolved = path.resolve(baseDir, ref.path);
  const root = path.resolve(baseDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new KeyArtifactsMetadataError(
      `Key file reference escapes artifact directory: ${ref.path}`,
    );
  }
  return resolved;
}

export function fingerprintsEqual(a: KeyFingerprint, b: KeyFingerprint): boolean {
  return a.sha256 === b.sha256 && a.size === b.size;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  } catch (cause) {
    throw new KeyArtifactsMetadataError(
      `Failed to read key metadata at ${filePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmpPath, filePath);
}

function parseKeyArtifactsMetadata(
  value: unknown,
  filePath: string,
): KeyArtifactsMetadata {
  if (!isRecord(value)) {
    throw invalidMetadata(filePath, "expected an object");
  }
  if (value["format"] !== KEY_ARTIFACTS_FORMAT) {
    throw invalidMetadata(
      filePath,
      `unsupported format ${JSON.stringify(value["format"])}`,
    );
  }
  const programId = expectString(value, "programId", filePath);
  const sourceHash = expectString(value, "sourceHash", filePath);
  const importsHash = expectString(value, "importsHash", filePath);
  const functionsRaw = value["functions"];
  const functions = functionsRaw === undefined
    ? undefined
    : expectFunctionRefs(functionsRaw, filePath);

  return {
    format: KEY_ARTIFACTS_FORMAT,
    programId,
    sourceHash,
    importsHash,
    ...(functions === undefined ? {} : { functions }),
  };
}

function parseRuntimeKeyCacheMetadata(
  value: unknown,
  filePath: string,
): RuntimeKeyCacheMetadata {
  if (!isRecord(value)) {
    throw invalidMetadata(filePath, "expected an object");
  }
  if (value["format"] !== RUNTIME_KEY_CACHE_FORMAT) {
    throw invalidMetadata(
      filePath,
      `unsupported format ${JSON.stringify(value["format"])}`,
    );
  }
  const identity = expectIdentity(value["identity"], filePath);
  const prover = expectFingerprint(value["prover"], "prover", filePath);
  const verifier = expectFingerprint(value["verifier"], "verifier", filePath);
  const diagnostics = value["diagnostics"] === undefined
    ? undefined
    : expectDiagnostics(value["diagnostics"], filePath);

  return {
    format: RUNTIME_KEY_CACHE_FORMAT,
    identity,
    prover,
    verifier,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function expectFunctionRefs(
  value: unknown,
  filePath: string,
): KeyArtifactFunctionRef[] {
  if (!Array.isArray(value)) {
    throw invalidMetadata(filePath, "functions must be an array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw invalidMetadata(filePath, `functions[${index}] must be an object`);
    }
    const transition = expectString(entry, "transition", filePath);
    const prover = entry["prover"] === undefined
      ? undefined
      : expectKeyFileRef(entry["prover"], `functions[${index}].prover`, filePath);
    const verifier = entry["verifier"] === undefined
      ? undefined
      : expectKeyFileRef(entry["verifier"], `functions[${index}].verifier`, filePath);
    return {
      transition,
      ...(prover === undefined ? {} : { prover }),
      ...(verifier === undefined ? {} : { verifier }),
    };
  });
}

function expectKeyFileRef(value: unknown, label: string, filePath: string): KeyFileRef {
  if (!isRecord(value)) {
    throw invalidMetadata(filePath, `${label} must be an object`);
  }
  return {
    path: expectString(value, "path", filePath),
    fingerprint: expectFingerprint(value["fingerprint"], `${label}.fingerprint`, filePath),
  };
}

function expectIdentity(value: unknown, filePath: string): RuntimeKeyIdentity {
  if (!isRecord(value)) {
    throw invalidMetadata(filePath, "identity must be an object");
  }
  const edition = value["edition"];
  if (
    edition !== undefined &&
    (typeof edition !== "number" || !Number.isInteger(edition) || edition < 0)
  ) {
    throw invalidMetadata(filePath, "identity.edition must be a non-negative integer");
  }
  return {
    network: expectString(value, "network", filePath),
    programId: expectString(value, "programId", filePath),
    transition: expectString(value, "transition", filePath),
    ...(edition === undefined ? {} : { edition: edition as number }),
    sourceHash: expectString(value, "sourceHash", filePath),
    importsHash: expectString(value, "importsHash", filePath),
    wasmHash: expectString(value, "wasmHash", filePath),
  };
}

function expectDiagnostics(
  value: unknown,
  filePath: string,
): RuntimeKeyCacheDiagnostics {
  if (!isRecord(value)) {
    throw invalidMetadata(filePath, "diagnostics must be an object");
  }
  const diagnostics: RuntimeKeyCacheDiagnostics = {};
  const sdkVersion = value["sdkVersion"];
  const wasmVersion = value["wasmVersion"];
  if (sdkVersion !== undefined) {
    if (typeof sdkVersion !== "string") {
      throw invalidMetadata(filePath, "diagnostics.sdkVersion must be a string");
    }
    (diagnostics as { sdkVersion?: string }).sdkVersion = sdkVersion;
  }
  if (wasmVersion !== undefined) {
    if (typeof wasmVersion !== "string") {
      throw invalidMetadata(filePath, "diagnostics.wasmVersion must be a string");
    }
    (diagnostics as { wasmVersion?: string }).wasmVersion = wasmVersion;
  }
  return diagnostics;
}

function expectFingerprint(
  value: unknown,
  label: string,
  filePath: string,
): KeyFingerprint {
  if (!isRecord(value)) {
    throw invalidMetadata(filePath, `${label} must be an object`);
  }
  const sha256 = value["sha256"];
  const size = value["size"];
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw invalidMetadata(filePath, `${label}.sha256 must be a SHA-256 hex string`);
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw invalidMetadata(filePath, `${label}.size must be a non-negative integer`);
  }
  return { sha256, size };
}

function expectString(
  value: Record<string, unknown>,
  key: string,
  filePath: string,
): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw invalidMetadata(filePath, `${key} must be a non-empty string`);
  }
  return raw;
}

function invalidMetadata(filePath: string, reason: string): KeyArtifactsMetadataError {
  return new KeyArtifactsMetadataError(`Invalid key metadata at ${filePath}: ${reason}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
