import type {
  AbiInput,
  AbiOutput,
  AleoType,
  ConstParameterABI,
  InterfaceRefABI,
  MappingABI,
  Mode,
  PlaintextType,
  ProgramABI,
  RecordABI,
  RecordRef,
  StorageType,
  StorageVariableABI,
  StructABI,
  StructRef,
  TransitionABI,
  ViewABI,
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
 * Accepts three wire shapes and normalizes all of them into one internal
 * representation (`transitions`/`is_async`/`name`):
 *   - Leo 4.1 / bytecode `leo abi`: I/O elements wrapped as `{ name?, ty, mode }`.
 *   - Leo 4.2: I/O elements are the bare enum variant (`{ Plaintext: { ty, mode } }`,
 *     `{ Record: { path, program } }`, `"Final"`, `"DynamicRecord"`) with input
 *     names dropped; `is_final`/`const_parameters`/`implements` removed.
 *   - The already-normalized internal shape (re-parsing a stored snapshot is a
 *     fixed point — the same canonicalization applies again idempotently).
 *
 * Canonicalization (version-agnostic, so a 4.1 snapshot and a fresh 4.2 ABI for
 * the same program normalize to the same representation):
 *   - Input names are synthesized as `arg{i}` only when absent; existing names preserved.
 *   - `Mode::None`/absent plaintext mode → `Private` (transitions/record fields) or
 *     `Public` (views); `Public`/`Private`/`Constant` pass through; non-plaintext I/O
 *     gets an inert `Private`.
 *   - `is_async` is taken from `is_async`, else `is_final`, else inferred from a `Future`/`Final` output.
 *   - Self-referential struct/record refs (`program === <self>.aleo`) are rewritten to
 *     `program: null` across every plaintext surface (structs, records, mappings,
 *     storage variables, function/view I/O).
 *
 * Type identity is otherwise preserved: struct/record refs keep full path and
 * program, Optional and StorageType::Vector wrappers are retained, and
 * DynamicRecord passes through as a first-class variant.
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
    structs: asArray(obj["structs"], "structs").map((s) => normalizeStruct(s, programId)),
    records: asArray(obj["records"], "records").map((r) => normalizeRecord(r, programId)),
    mappings: asArray(obj["mappings"], "mappings").map((m) => normalizeMapping(m, programId)),
    storage_variables: asArray(obj["storage_variables"], "storage_variables").map((v) =>
      normalizeStorageVariable(v, programId),
    ),
    transitions: asArray(rawFunctions, "functions/transitions").map((f) =>
      normalizeFunction(f, programId),
    ),
  };

  const views = asArray(obj["views"], "views").map((view) => normalizeView(view, programId));
  if (views.length > 0) {
    (abi as { views: readonly ViewABI[] }).views = views;
  }

  const implementedInterfaces = asArray(obj["implements"], "implements").map(normalizeInterfaceRef);
  if (implementedInterfaces.length > 0) {
    (abi as { implements: readonly InterfaceRefABI[] }).implements = implementedInterfaces;
  }

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
  for (const view of abi.views ?? []) {
    if (typeof view.name !== "string") {
      throw new AbiParseError("View missing 'name' field");
    }
    if (!Array.isArray(view.inputs)) {
      throw new AbiParseError(`View "${view.name}" missing 'inputs' array`);
    }
    if (!Array.isArray(view.outputs)) {
      throw new AbiParseError(`View "${view.name}" missing 'outputs' array`);
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
 * Compiler (4.1): `{ name, is_final, inputs, outputs }`
 * Compiler (4.2): `{ name, inputs, outputs }` (is_final dropped)
 * Internal:       `{ name, is_async, inputs, outputs }`
 */
function normalizeFunction(raw: unknown, programId: string): TransitionABI {
  if (typeof raw !== "object" || raw === null) return raw as TransitionABI;
  const obj = raw as Record<string, unknown>;

  const rawInputs = obj["inputs"] === undefined ? [] : obj["inputs"];
  const rawOutputs = obj["outputs"] === undefined ? [] : obj["outputs"];

  const inputs = Array.isArray(rawInputs)
    ? rawInputs.map((i, index) => normalizeInput(i, programId, "transition", index))
    : (rawInputs as unknown as AbiInput[]);
  const outputs = Array.isArray(rawOutputs)
    ? rawOutputs.map((o) => normalizeOutput(o, programId, "transition"))
    : (rawOutputs as unknown as AbiOutput[]);

  // is_async: prefer an explicit flag (internal `is_async`, 4.1 `is_final`);
  // 4.2 dropped both, so infer "has finalize" from a Future/Final output.
  const isAsync =
    "is_async" in obj
      ? Boolean(obj["is_async"])
      : "is_final" in obj
        ? Boolean(obj["is_final"])
        : outputs.some((o) => isFutureOutput(o.ty));

  const normalized: TransitionABI = {
    name: obj["name"] as string,
    is_async: isAsync,
    inputs,
    outputs,
  };
  const constParameters = normalizeConstParameters(
    obj["const_parameters"],
    "function.const_parameters",
  );
  if (constParameters.length > 0) {
    (normalized as { const_parameters: readonly ConstParameterABI[] }).const_parameters =
      constParameters;
  }
  return normalized;
}

function normalizeView(raw: unknown, programId: string): ViewABI {
  if (typeof raw !== "object" || raw === null) return raw as ViewABI;
  const obj = raw as Record<string, unknown>;
  const rawInputs = obj["inputs"] === undefined ? [] : obj["inputs"];
  const rawOutputs = obj["outputs"] === undefined ? [] : obj["outputs"];

  const normalized: ViewABI = {
    name: obj["name"] as string,
    inputs: Array.isArray(rawInputs)
      ? rawInputs.map((i, index) => normalizeInput(i, programId, "view", index))
      : (rawInputs as unknown as AbiInput[]),
    outputs: Array.isArray(rawOutputs)
      ? rawOutputs.map((o) => normalizeOutput(o, programId, "view"))
      : (rawOutputs as unknown as AbiOutput[]),
  };
  const constParameters = normalizeConstParameters(
    obj["const_parameters"],
    "view.const_parameters",
  );
  if (constParameters.length > 0) {
    (normalized as { const_parameters: readonly ConstParameterABI[] }).const_parameters =
      constParameters;
  }
  return normalized;
}

/**
 * I/O context drives default plaintext-mode canonicalization: unmoded
 * transition plaintext defaults to `Private`, unmoded view plaintext to `Public`.
 */
type IoContext = "transition" | "view";

/**
 * Detect which wire shape a single function/view input or output element uses:
 *   - `"bare"`: a bare string variant (`"Final"`/`"Future"`/`"DynamicRecord"`).
 *   - `"wrapper"`: the 4.1/internal `{ name?, ty, mode }` envelope (the top-level
 *     `ty` key wins, so a 4.1 input literally named `Plaintext` is not misread).
 *   - `"positional"`: the 4.2 bare enum variant (`{ Plaintext }`/`{ Record }`/`{ Future }`).
 */
function detectInputShape(raw: unknown): "bare" | "wrapper" | "positional" {
  if (typeof raw === "string") return "bare";
  if (typeof raw !== "object" || raw === null) return "wrapper";
  const obj = raw as Record<string, unknown>;
  if ("ty" in obj) return "wrapper";
  if ("Plaintext" in obj || "Record" in obj || "Future" in obj) return "positional";
  return "wrapper";
}

/**
 * Canonicalize a plaintext mode: absent/`"None"` collapses to the context
 * default (`Public` for views, `Private` for transitions); `Public`/`Private`/
 * `Constant` pass through.
 */
function canonicalizePlaintextMode(rawMode: unknown, ioContext: IoContext): Mode {
  if (rawMode === "Public" || rawMode === "Private" || rawMode === "Constant") return rawMode;
  return ioContext === "view" ? "Public" : "Private";
}

/**
 * Mode for an already-normalized AleoType: plaintext gets context-canonicalized,
 * everything else (Record/Future/DynamicRecord) carries an inert `Private`.
 */
function modeForAleoType(ty: AleoType, rawMode: unknown, ioContext: IoContext): Mode {
  if (typeof ty === "object" && ty !== null && "Plaintext" in ty) {
    return canonicalizePlaintextMode(rawMode, ioContext);
  }
  return "Private";
}

function isFutureOutput(ty: AleoType): boolean {
  return typeof ty === "object" && ty !== null && "Future" in ty;
}

function normalizeInput(
  raw: unknown,
  programId: string,
  ioContext: IoContext,
  index: number,
): AbiInput {
  const shape = detectInputShape(raw);

  if (shape === "positional") {
    const obj = raw as Record<string, unknown>;
    if ("Plaintext" in obj) {
      const inner = (obj["Plaintext"] ?? {}) as Record<string, unknown>;
      return {
        name: `arg${index}`,
        ty: { Plaintext: normalizePlaintext(inner["ty"], programId) },
        mode: canonicalizePlaintextMode(inner["mode"], ioContext),
      };
    }
    if ("Record" in obj) {
      return {
        name: `arg${index}`,
        ty: { Record: toRecordRef(obj["Record"], programId) },
        mode: "Private",
      };
    }
    return {
      name: `arg${index}`,
      ty: { Future: obj["Future"] as string },
      mode: "Private",
    };
  }

  if (shape === "bare") {
    return { name: `arg${index}`, ty: normalizeAleoType(raw, programId), mode: "Private" };
  }

  // wrapper (4.1 / internal): { name?, ty, mode }
  const obj = raw as Record<string, unknown>;
  const ty = normalizeAleoType(obj["ty"], programId);
  return {
    name: typeof obj["name"] === "string" ? (obj["name"] as string) : `arg${index}`,
    ty,
    mode: modeForAleoType(ty, obj["mode"], ioContext),
  };
}

function normalizeOutput(raw: unknown, programId: string, ioContext: IoContext): AbiOutput {
  const shape = detectInputShape(raw);

  if (shape === "positional") {
    const obj = raw as Record<string, unknown>;
    if ("Plaintext" in obj) {
      const inner = (obj["Plaintext"] ?? {}) as Record<string, unknown>;
      return {
        ty: { Plaintext: normalizePlaintext(inner["ty"], programId) },
        mode: canonicalizePlaintextMode(inner["mode"], ioContext),
      };
    }
    if ("Record" in obj) {
      return { ty: { Record: toRecordRef(obj["Record"], programId) }, mode: "Private" };
    }
    return { ty: { Future: obj["Future"] as string }, mode: "Private" };
  }

  if (shape === "bare") {
    return { ty: normalizeAleoType(raw, programId), mode: "Private" };
  }

  // wrapper (4.1 / internal): { ty, mode }
  const obj = raw as Record<string, unknown>;
  const ty = normalizeAleoType(obj["ty"], programId);
  return { ty, mode: modeForAleoType(ty, obj["mode"], ioContext) };
}

/**
 * Normalize a struct entry.
 *
 * Compiler: `{ path: ["TokenInfo"], fields }`
 * Internal: `{ path: ["TokenInfo"], fields }` (full path preserved)
 */
function normalizeStruct(raw: unknown, programId: string): StructABI {
  if (typeof raw !== "object" || raw === null) return raw as StructABI;
  const obj = raw as Record<string, unknown>;

  return {
    path: extractPath(obj),
    fields: asArray(obj["fields"], "struct.fields").map((f) => {
      const field = f as Record<string, unknown>;
      return {
        name: field["name"] as string,
        ty: normalizePlaintext(field["ty"], programId),
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
function normalizeRecord(raw: unknown, programId: string): RecordABI {
  if (typeof raw !== "object" || raw === null) return raw as RecordABI;
  const obj = raw as Record<string, unknown>;

  return {
    path: extractPath(obj),
    fields: asArray(obj["fields"], "record.fields").map((f) => {
      const field = f as Record<string, unknown>;
      return {
        name: field["name"] as string,
        ty: normalizePlaintext(field["ty"], programId),
        // Record-definition fields: absent/None → Private; Public/Constant pass through.
        mode: canonicalizeRecordFieldMode(field["mode"]),
      };
    }),
  };
}

function canonicalizeRecordFieldMode(rawMode: unknown): Mode {
  if (rawMode === "Public" || rawMode === "Private" || rawMode === "Constant") return rawMode;
  return "Private";
}

function normalizeMapping(raw: unknown, programId: string): MappingABI {
  if (typeof raw !== "object" || raw === null) return raw as MappingABI;
  const obj = raw as Record<string, unknown>;

  return {
    name: obj["name"] as string,
    key: normalizePlaintext(obj["key"], programId),
    value: normalizePlaintext(obj["value"], programId),
  };
}

function normalizeStorageVariable(raw: unknown, programId: string): StorageVariableABI {
  if (typeof raw !== "object" || raw === null) return raw as StorageVariableABI;
  const obj = raw as Record<string, unknown>;

  return {
    name: obj["name"] as string,
    ty: normalizeStorageType(obj["ty"], programId),
  };
}

function normalizeConstParameters(raw: unknown, fieldName: string): readonly ConstParameterABI[] {
  return asArray(raw, fieldName) as ConstParameterABI[];
}

function normalizeInterfaceRef(raw: unknown): InterfaceRefABI {
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as { path?: unknown; program?: unknown };
    if (Array.isArray(obj.path)) {
      return {
        path: obj.path.map(String),
        program: typeof obj.program === "string" ? obj.program : null,
      };
    }
  }
  return String(raw);
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
  // "Final" (v4) or "Future" (v3.5) string → { Future: programId }
  if (raw === "Final" || raw === "Future") return { Future: programId };

  // "DynamicRecord" — first-class variant
  if (raw === "DynamicRecord") return "DynamicRecord";

  if (typeof raw !== "object" || raw === null) return raw as AleoType;
  const obj = raw as Record<string, unknown>;

  // { Record: ... } → { Record: RecordRef }
  if ("Record" in obj) {
    return { Record: toRecordRef(obj["Record"], programId) };
  }

  // { Future: "..." } — already normalized
  if ("Future" in obj) return { Future: obj["Future"] as string };

  // { Plaintext: ... } — recurse into plaintext normalization
  if ("Plaintext" in obj) {
    return { Plaintext: normalizePlaintext(obj["Plaintext"], programId) };
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
function normalizePlaintext(raw: unknown, programId: string): PlaintextType {
  if (typeof raw !== "object" || raw === null) return raw as PlaintextType;
  const obj = raw as Record<string, unknown>;

  // { Struct: ... } → { Struct: StructRef }
  if ("Struct" in obj) {
    return { Struct: toStructRef(obj["Struct"], programId) };
  }

  // { Array: { element, length } } → { Array: [normalized, length] }
  if ("Array" in obj) {
    const arrVal = obj["Array"];
    if (Array.isArray(arrVal)) {
      // Already in tuple format [type, length]
      return { Array: [normalizePlaintext(arrVal[0], programId), arrVal[1] as number] };
    }
    if (typeof arrVal === "object" && arrVal !== null) {
      const arr = arrVal as { element: unknown; length: number };
      return { Array: [normalizePlaintext(arr.element, programId), arr.length] };
    }
  }

  // { Optional: innerType } — preserved
  if ("Optional" in obj) {
    return { Optional: normalizePlaintext(obj["Optional"], programId) };
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
function normalizeStorageType(raw: unknown, programId: string): StorageType {
  if (typeof raw !== "object" || raw === null) {
    return { Plaintext: raw as PlaintextType };
  }
  const obj = raw as Record<string, unknown>;

  // { Plaintext: ... } — compiler StorageType::Plaintext
  if ("Plaintext" in obj) {
    return { Plaintext: normalizePlaintext(obj["Plaintext"], programId) };
  }

  // { Vector: ... } — compiler StorageType::Vector
  if ("Vector" in obj) {
    return { Vector: normalizeStorageType(obj["Vector"], programId) };
  }

  // Bare PlaintextType from old format — wrap in Plaintext
  return { Plaintext: normalizePlaintext(raw, programId) };
}

// ---------------------------------------------------------------------------
// Ref constructors
// ---------------------------------------------------------------------------

/**
 * Self-reference canonicalization: Leo 4.2 emits self-refs with an explicit
 * `program: "<self>.aleo"` where 4.1 emitted `program: null`. Collapse the
 * self form to `null` (the historical local convention) so a 4.1 self-ref and
 * a 4.2 self-ref compare equal everywhere.
 */
function canonicalizeRefProgram(program: string | null, programId: string): string | null {
  return program === programId ? null : program;
}

function toStructRef(raw: unknown, programId: string): StructRef {
  // Already a full ref: { path: [...], program: ... }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as { path?: string[]; program?: string | null };
    if (Array.isArray(obj.path)) {
      return { path: obj.path, program: canonicalizeRefProgram(obj.program ?? null, programId) };
    }
  }
  // Old format: bare string name
  if (typeof raw === "string") {
    return { path: [raw], program: null };
  }
  return { path: [String(raw)], program: null };
}

function toRecordRef(raw: unknown, programId: string): RecordRef {
  // Already a full ref: { path: [...], program: ... }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as { path?: string[]; program?: string | null };
    if (Array.isArray(obj.path)) {
      return { path: obj.path, program: canonicalizeRefProgram(obj.program ?? null, programId) };
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
