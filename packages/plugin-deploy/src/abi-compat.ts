/**
 * ABI compatibility checker for program upgrades.
 *
 * Rules (per Leo v4 / ARC-0006 upgrade spec):
 * - Mappings can be ADDED but not deleted or modified (key/value types must match)
 * - Structs can be ADDED but not deleted or modified (fields must match exactly)
 * - Records can be ADDED but not deleted or modified (fields must match exactly)
 * - Transitions can be ADDED; existing transitions cannot be deleted and their
 *   input/output signatures must remain unchanged (logic-only changes are fine).
 *   Inputs are compared POSITIONALLY (by mode + type), matching Leo's
 *   `--satisfies`; parameter names are not part of the signature.
 * - Views can be ADDED; existing views cannot be deleted and their signatures
 *   must remain unchanged
 * - Storage variables can be ADDED but not deleted or modified
 *
 * Version-agnostic: both ABIs are routed back through `parseAbi` at entry, so a
 * stored Leo 4.1 snapshot (mode `None`, named inputs, explicit `implements`/
 * `const_parameters`, `null` self-refs) and a fresh Leo 4.2 ABI for the same
 * program canonicalize to the same internal shape before comparison. The two
 * fields Leo 4.2 removed — `implements` (interface conformance now lives in
 * `leo abi --satisfies`) and `const_parameters` — are intentionally NOT
 * enforced, so a legitimate 4.1 → 4.2 upgrade does not falsely flag.
 */

import type {
  AbiInput,
  AbiOutput,
  AleoType,
  MappingABI,
  PlaintextType,
  ProgramABI,
  RecordABI,
  RecordFieldABI,
  StorageType,
  StorageVariableABI,
  StructABI,
  StructFieldABI,
  TransitionABI,
  ViewABI,
} from "@lionden/leo-compiler";
import { parseAbi } from "@lionden/leo-compiler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AbiViolation {
  readonly kind:
    | "mapping_deleted"
    | "mapping_modified"
    | "struct_deleted"
    | "struct_modified"
    | "record_deleted"
    | "record_modified"
    | "transition_deleted"
    | "transition_modified"
    | "view_deleted"
    | "view_modified"
    | "storage_variable_deleted"
    | "storage_variable_modified";
  readonly name: string;
  readonly detail: string;
}

export interface AbiCompatResult {
  readonly compatible: boolean;
  readonly violations: readonly AbiViolation[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a new ABI is upgrade-compatible with the old ABI.
 */
export function checkAbiCompatibility(oldAbi: ProgramABI, newAbi: ProgramABI): AbiCompatResult {
  const violations: AbiViolation[] = [];

  // Canonicalize both sides through the parser before comparing. parseAbi is
  // idempotent on the internal shape and applies the version-agnostic
  // canonicalization (mode None→Private/Public, self-ref→null, name synthesis)
  // to a stored 4.1 snapshot, so old/new modes, self-refs, and input shapes
  // align across the 4.1 → 4.2 boundary.
  const o = parseAbi(JSON.stringify(oldAbi));
  const n = parseAbi(JSON.stringify(newAbi));

  // Check mappings
  checkNamedItems(o.mappings, n.mappings, "mapping", compareMappings, violations, (m) => m.name);

  // Check structs (keyed by full path to avoid module collisions)
  checkNamedItems(o.structs, n.structs, "struct", compareStructs, violations, (s) =>
    s.path.join("::"),
  );

  // Check records (keyed by full path to avoid module collisions)
  checkNamedItems(o.records, n.records, "record", compareRecords, violations, (r) =>
    r.path.join("::"),
  );

  // Check transitions (can be added; cannot be deleted or have signature modified)
  checkNamedItems(
    o.transitions,
    n.transitions,
    "transition",
    compareTransitionSignatures,
    violations,
    (t) => t.name,
  );

  checkNamedItems(
    o.views ?? [],
    n.views ?? [],
    "view",
    compareViewSignatures,
    violations,
    (view) => view.name,
  );

  // Implemented interfaces are intentionally NOT checked: Leo 4.2 removed
  // `Program.implements` from the ABI, so a 4.1 snapshot carrying `implements`
  // vs. a 4.2 ABI without it must not flag. Interface conformance is enforced
  // by `leo abi --satisfies` instead.

  // Check storage variables
  checkNamedItems(
    o.storage_variables,
    n.storage_variables,
    "storage_variable",
    compareStorageVariables,
    violations,
    (sv) => sv.name,
  );

  return {
    compatible: violations.length === 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Comparator<T> = (oldItem: T, newItem: T) => string | null;

function checkNamedItems<T>(
  oldItems: readonly T[],
  newItems: readonly T[],
  kind: string,
  compare: Comparator<T>,
  violations: AbiViolation[],
  keyFn: (item: T) => string,
): void {
  const newMap = new Map(newItems.map((item) => [keyFn(item), item]));

  for (const oldItem of oldItems) {
    const key = keyFn(oldItem);
    const newItem = newMap.get(key);
    if (!newItem) {
      violations.push({
        kind: `${kind}_deleted` as AbiViolation["kind"],
        name: key,
        detail: `${kind} "${key}" was deleted`,
      });
      continue;
    }

    const diff = compare(oldItem, newItem);
    if (diff) {
      violations.push({
        kind: `${kind}_modified` as AbiViolation["kind"],
        name: key,
        detail: diff,
      });
    }
  }
}

function compareTransitionSignatures(oldT: TransitionABI, newT: TransitionABI): string | null {
  if (oldT.is_async !== newT.is_async) {
    return `transition "${oldT.name}" async mode changed (${oldT.is_async} -> ${newT.is_async})`;
  }
  if (oldT.inputs.length !== newT.inputs.length) {
    return `transition "${oldT.name}" input count changed (${oldT.inputs.length} -> ${newT.inputs.length})`;
  }
  if (oldT.outputs.length !== newT.outputs.length) {
    return `transition "${oldT.name}" output count changed (${oldT.outputs.length} -> ${newT.outputs.length})`;
  }
  for (let i = 0; i < oldT.inputs.length; i++) {
    const oldIn = oldT.inputs[i]!;
    const newIn = newT.inputs[i]!;
    if (!transitionInputsEqual(oldIn, newIn)) {
      return `transition "${oldT.name}" input[${i}] changed`;
    }
  }
  for (let i = 0; i < oldT.outputs.length; i++) {
    const oldOut = oldT.outputs[i]!;
    const newOut = newT.outputs[i]!;
    if (!transitionOutputsEqual(oldOut, newOut)) {
      return `transition "${oldT.name}" output[${i}] changed`;
    }
  }
  // const_parameters intentionally not compared: Leo 4.2 removed the field, and
  // codegen already rejects executable const parameters, so there is nothing to
  // enforce here.
  return null;
}

function compareViewSignatures(oldView: ViewABI, newView: ViewABI): string | null {
  if (oldView.inputs.length !== newView.inputs.length) {
    return `view "${oldView.name}" input count changed (${oldView.inputs.length} -> ${newView.inputs.length})`;
  }
  if (oldView.outputs.length !== newView.outputs.length) {
    return `view "${oldView.name}" output count changed (${oldView.outputs.length} -> ${newView.outputs.length})`;
  }
  for (let i = 0; i < oldView.inputs.length; i++) {
    const oldIn = oldView.inputs[i]!;
    const newIn = newView.inputs[i]!;
    if (!transitionInputsEqual(oldIn, newIn)) {
      return `view "${oldView.name}" input[${i}] changed`;
    }
  }
  for (let i = 0; i < oldView.outputs.length; i++) {
    const oldOut = oldView.outputs[i]!;
    const newOut = newView.outputs[i]!;
    if (!transitionOutputsEqual(oldOut, newOut)) {
      return `view "${oldView.name}" output[${i}] changed`;
    }
  }
  // const_parameters intentionally not compared (see compareTransitionSignatures).
  return null;
}

function compareMappings(oldMapping: MappingABI, newMapping: MappingABI): string | null {
  if (!plaintextTypesEqual(oldMapping.key, newMapping.key)) {
    return `mapping "${oldMapping.name}" key type changed`;
  }
  if (!plaintextTypesEqual(oldMapping.value, newMapping.value)) {
    return `mapping "${oldMapping.name}" value type changed`;
  }
  return null;
}

function compareStructs(oldStruct: StructABI, newStruct: StructABI): string | null {
  const key = oldStruct.path.join("::");
  if (oldStruct.fields.length !== newStruct.fields.length) {
    return `struct "${key}" field count changed (${oldStruct.fields.length} -> ${newStruct.fields.length})`;
  }

  for (let i = 0; i < oldStruct.fields.length; i++) {
    const oldField = oldStruct.fields[i]!;
    const newField = newStruct.fields[i]!;
    if (!structFieldsEqual(oldField, newField)) {
      return `struct "${key}" field "${oldField.name}" changed`;
    }
  }

  return null;
}

function compareRecords(oldRecord: RecordABI, newRecord: RecordABI): string | null {
  const key = oldRecord.path.join("::");
  if (oldRecord.fields.length !== newRecord.fields.length) {
    return `record "${key}" field count changed (${oldRecord.fields.length} -> ${newRecord.fields.length})`;
  }

  for (let i = 0; i < oldRecord.fields.length; i++) {
    const oldField = oldRecord.fields[i]!;
    const newField = newRecord.fields[i]!;
    if (!recordFieldsEqual(oldField, newField)) {
      return `record "${key}" field "${oldField.name}" changed`;
    }
  }

  return null;
}

function compareStorageVariables(
  oldVar: StorageVariableABI,
  newVar: StorageVariableABI,
): string | null {
  if (!storageTypesEqual(oldVar.ty, newVar.ty)) {
    return `storage variable "${oldVar.name}" type changed`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Type equality
// ---------------------------------------------------------------------------

function plaintextTypesEqual(a: PlaintextType, b: PlaintextType): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function storageTypesEqual(a: StorageType, b: StorageType): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function structFieldsEqual(a: StructFieldABI, b: StructFieldABI): boolean {
  return a.name === b.name && plaintextTypesEqual(a.ty, b.ty);
}

function recordFieldsEqual(a: RecordFieldABI, b: RecordFieldABI): boolean {
  return a.name === b.name && a.mode === b.mode && plaintextTypesEqual(a.ty, b.ty);
}

function aleoTypesEqual(a: AleoType, b: AleoType): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function transitionInputsEqual(a: AbiInput, b: AbiInput): boolean {
  // Positional comparison (mode + type) — names are not part of the signature
  // and are synthesized for 4.2 ABIs, so comparing them would falsely flag a
  // 4.1 named input against its 4.2 positional twin.
  return a.mode === b.mode && aleoTypesEqual(a.ty, b.ty);
}

function transitionOutputsEqual(a: AbiOutput, b: AbiOutput): boolean {
  return a.mode === b.mode && aleoTypesEqual(a.ty, b.ty);
}
