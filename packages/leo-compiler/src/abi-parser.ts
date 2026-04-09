import type {
  ProgramABI,
  TransitionABI,
  StructABI,
  RecordABI,
  MappingABI,
  StorageVariableABI,
  StorageType,
  AbiInput,
  AbiOutput,
  AleoType,
  PlaintextType,
  StructRef,
  RecordRef,
} from "./abi-types.js";

export class AbiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbiParseError";
  }
}

/**
 * Parse a JSON ABI string into a typed ProgramABI structure.
 *
 * Handles the real Leo compiler output format (`functions`/`is_final`/`path`)
 * and normalizes it into the internal LionDen representation
 * (`transitions`/`is_async`/`name`).
 *
 * Type identity is preserved: struct/record refs keep full path and program,
 * Optional and StorageType::Vector wrappers are retained, and DynamicRecord
 * passes through as a first-class variant.
 *
 * Also accepts the already-normalized format for backwards compatibility.
 */
export function parseAbi(json: string): ProgramABI {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new AbiParseError("Invalid JSON in ABI file");
  }

  if (typeof raw !== "object" || raw === null) {
    throw new AbiParseError("ABI must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj["program"] !== "string") {
    throw new AbiParseError('ABI missing required "program" field');
  }

  const programId = obj["program"] as string;

  // The compiler emits "functions"; the internal format uses "transitions".
  // Accept either, preferring "functions" (the compiler format).
  const rawFunctions = obj["functions"] ?? obj["transitions"];

  const abi: ProgramABI = {
    program: programId,
    structs: asArray(obj["structs"], "structs").map(normalizeStruct),
    records: asArray(obj["records"], "records").map(normalizeRecord),
    mappings: asArray(obj["mappings"], "mappings").map(normalizeMapping),
    storage_variables: asArray(obj["storage_variables"], "storage_variables").map(normalizeStorageVariable),
    transitions: asArray(rawFunctions, "functions/transitions").map((f) =>
      normalizeFunction(f, programId),
    ),
  };

  // Validate transition structure
  for (const t of abi.transitions) {
    if (typeof t.name !== "string") {
      throw new AbiParseError("Transition missing 'name' field");
    }
    if (!Array.isArray(t.inputs)) {
      throw new AbiParseError(`Transition "${t.name}" missing 'inputs' array`);
    }
    if (!Array.isArray(t.outputs)) {
      throw new AbiParseError(`Transition "${t.name}" missing 'outputs' array`);
    }
  }

  return abi;
}

// ---------------------------------------------------------------------------
// Array helper
// ---------------------------------------------------------------------------

function asArray<T>(value: unknown, fieldName: string): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AbiParseError(`"${fieldName}" must be an array`);
  }
  return value as T[];
}

// ---------------------------------------------------------------------------
// Top-level entry normalizers
// ---------------------------------------------------------------------------

/**
 * Normalize a function entry from the compiler format to the internal format.
 *
 * Compiler: `{ name, is_final, inputs, outputs }`
 * Internal: `{ name, is_async, inputs, outputs }`
 */
function normalizeFunction(raw: unknown, programId: string): TransitionABI {
  if (typeof raw !== "object" || raw === null) return raw as TransitionABI;
  const obj = raw as Record<string, unknown>;

  // Map is_final → is_async (accept either)
  const isAsync =
    "is_async" in obj
      ? Boolean(obj["is_async"])
      : Boolean(obj["is_final"]);

  const rawInputs = obj["inputs"] === undefined ? [] : obj["inputs"];
  const rawOutputs = obj["outputs"] === undefined ? [] : obj["outputs"];

  return {
    name: obj["name"] as string,
    is_async: isAsync,
    inputs: Array.isArray(rawInputs)
      ? rawInputs.map((i) => normalizeInput(i as Record<string, unknown>, programId))
      : rawInputs as unknown as AbiInput[],
    outputs: Array.isArray(rawOutputs)
      ? rawOutputs.map((o) => normalizeOutput(o as Record<string, unknown>, programId))
      : rawOutputs as unknown as AbiOutput[],
  };
}

function normalizeInput(raw: Record<string, unknown>, programId: string): AbiInput {
  return {
    name: raw["name"] as string,
    ty: normalizeAleoType(raw["ty"], programId),
    mode: raw["mode"] as AbiInput["mode"],
  };
}

function normalizeOutput(raw: Record<string, unknown>, programId: string): AbiOutput {
  return {
    ty: normalizeAleoType(raw["ty"], programId),
    mode: raw["mode"] as AbiOutput["mode"],
  };
}

/**
 * Normalize a struct entry.
 *
 * Compiler: `{ path: ["TokenInfo"], fields }`
 * Internal: `{ path: ["TokenInfo"], fields }` (full path preserved)
 */
function normalizeStruct(raw: unknown): StructABI {
  if (typeof raw !== "object" || raw === null) return raw as StructABI;
  const obj = raw as Record<string, unknown>;

  return {
    path: extractPath(obj),
    fields: asArray(obj["fields"], "struct.fields").map((f) => {
      const field = f as Record<string, unknown>;
      return {
        name: field["name"] as string,
        ty: normalizePlaintext(field["ty"]),
      };
    }),
  };
}

/**
 * Normalize a record entry.
 *
 * Compiler: `{ path: ["Token"], fields }`
 * Internal: `{ path: ["Token"], fields }` (full path preserved)
 */
function normalizeRecord(raw: unknown): RecordABI {
  if (typeof raw !== "object" || raw === null) return raw as RecordABI;
  const obj = raw as Record<string, unknown>;

  return {
    path: extractPath(obj),
    fields: asArray(obj["fields"], "record.fields").map((f) => {
      const field = f as Record<string, unknown>;
      return {
        name: field["name"] as string,
        ty: normalizePlaintext(field["ty"]),
        mode: field["mode"] as RecordABI["fields"][number]["mode"],
      };
    }),
  };
}

function normalizeMapping(raw: unknown): MappingABI {
  if (typeof raw !== "object" || raw === null) return raw as MappingABI;
  const obj = raw as Record<string, unknown>;

  return {
    name: obj["name"] as string,
    key: normalizePlaintext(obj["key"]),
    value: normalizePlaintext(obj["value"]),
  };
}

function normalizeStorageVariable(raw: unknown): StorageVariableABI {
  if (typeof raw !== "object" || raw === null) return raw as StorageVariableABI;
  const obj = raw as Record<string, unknown>;

  return {
    name: obj["name"] as string,
    ty: normalizeStorageType(obj["ty"]),
  };
}

// ---------------------------------------------------------------------------
// Type normalizers
// ---------------------------------------------------------------------------

/**
 * Normalize a FunctionInput/FunctionOutput type.
 *
 * Handles:
 * - `"Final"` → `{ Future: programId }`
 * - `"DynamicRecord"` → `"DynamicRecord"` (preserved as first-class variant)
 * - `{ Record: { path, program } }` → `{ Record: RecordRef }` (identity preserved)
 * - `{ Record: "Name" }` → `{ Record: { path: ["Name"], program: null } }` (upgrade old format)
 * - `{ Plaintext: ... }` → `{ Plaintext: normalized }`
 */
function normalizeAleoType(raw: unknown, programId: string): AleoType {
  // "Final" string → { Future: programId }
  if (raw === "Final") return { Future: programId };

  // "DynamicRecord" — first-class variant
  if (raw === "DynamicRecord") return "DynamicRecord";

  if (typeof raw !== "object" || raw === null) return raw as AleoType;
  const obj = raw as Record<string, unknown>;

  // { Record: ... } → { Record: RecordRef }
  if ("Record" in obj) {
    return { Record: toRecordRef(obj["Record"]) };
  }

  // { Future: "..." } — already normalized
  if ("Future" in obj) return { Future: obj["Future"] as string };

  // { Plaintext: ... } — recurse into plaintext normalization
  if ("Plaintext" in obj) {
    return { Plaintext: normalizePlaintext(obj["Plaintext"]) };
  }

  return raw as AleoType;
}

/**
 * Normalize a Plaintext type, preserving full type identity.
 *
 * Handles:
 * - `{ Struct: { path, program? } }` → `{ Struct: StructRef }` (identity preserved)
 * - `{ Struct: "Name" }` → `{ Struct: { path: ["Name"], program: null } }` (upgrade old format)
 * - `{ Array: { element, length } }` → `{ Array: [normalized, length] }`
 * - `{ Optional: ... }` → `{ Optional: normalized }` (preserved, not erased)
 * - `{ Primitive: ... }` — passes through
 */
function normalizePlaintext(raw: unknown): PlaintextType {
  if (typeof raw !== "object" || raw === null) return raw as PlaintextType;
  const obj = raw as Record<string, unknown>;

  // { Struct: ... } → { Struct: StructRef }
  if ("Struct" in obj) {
    return { Struct: toStructRef(obj["Struct"]) };
  }

  // { Array: { element, length } } → { Array: [normalized, length] }
  if ("Array" in obj) {
    const arrVal = obj["Array"];
    if (Array.isArray(arrVal)) {
      // Already in tuple format [type, length]
      return { Array: [normalizePlaintext(arrVal[0]), arrVal[1] as number] };
    }
    if (typeof arrVal === "object" && arrVal !== null) {
      const arr = arrVal as { element: unknown; length: number };
      return { Array: [normalizePlaintext(arr.element), arr.length] };
    }
  }

  // { Optional: innerType } — preserved
  if ("Optional" in obj) {
    return { Optional: normalizePlaintext(obj["Optional"]) };
  }

  // { Primitive: ... } — pass through as-is
  return raw as PlaintextType;
}

/**
 * Normalize a StorageType, preserving Vector/Plaintext wrappers.
 *
 * Compiler format: `{ Plaintext: ... }` or `{ Vector: ... }`
 * Old internal format: bare PlaintextType (no wrapper) — wrapped into `{ Plaintext: ... }`
 */
function normalizeStorageType(raw: unknown): StorageType {
  if (typeof raw !== "object" || raw === null) {
    return { Plaintext: raw as PlaintextType };
  }
  const obj = raw as Record<string, unknown>;

  // { Plaintext: ... } — compiler StorageType::Plaintext
  if ("Plaintext" in obj) {
    return { Plaintext: normalizePlaintext(obj["Plaintext"]) };
  }

  // { Vector: ... } — compiler StorageType::Vector
  if ("Vector" in obj) {
    return { Vector: normalizeStorageType(obj["Vector"]) };
  }

  // Bare PlaintextType from old format — wrap in Plaintext
  return { Plaintext: normalizePlaintext(raw) };
}

// ---------------------------------------------------------------------------
// Ref constructors
// ---------------------------------------------------------------------------

function toStructRef(raw: unknown): StructRef {
  // Already a full ref: { path: [...], program: ... }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as { path?: string[]; program?: string | null };
    if (Array.isArray(obj.path)) {
      return { path: obj.path, program: obj.program ?? null };
    }
  }
  // Old format: bare string name
  if (typeof raw === "string") {
    return { path: [raw], program: null };
  }
  return { path: [String(raw)], program: null };
}

function toRecordRef(raw: unknown): RecordRef {
  // Already a full ref: { path: [...], program: ... }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as { path?: string[]; program?: string | null };
    if (Array.isArray(obj.path)) {
      return { path: obj.path, program: obj.program ?? null };
    }
  }
  // Old format: bare string name
  if (typeof raw === "string") {
    return { path: [raw], program: null };
  }
  return { path: [String(raw)], program: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the full path from either `{ path: [...] }` or `{ name: "..." }`.
 * Compiler format uses `path` (array of strings); old normalized format uses `name`
 * which is wrapped into a single-element array.
 */
function extractPath(obj: Record<string, unknown>): string[] {
  if (Array.isArray(obj["path"]) && obj["path"].length > 0) {
    return obj["path"] as string[];
  }
  if (typeof obj["name"] === "string") return [obj["name"] as string];
  throw new AbiParseError("Entry missing both 'name' and 'path' fields");
}
