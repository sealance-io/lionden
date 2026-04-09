/**
 * ABI compatibility checker for program upgrades.
 *
 * Rules (per ARC-0006):
 * - Mappings can be ADDED but not deleted or modified (key/value types must match)
 * - Structs can be ADDED but not deleted or modified (fields must match exactly)
 * - Records can be ADDED but not deleted or modified (fields must match exactly)
 * - Transitions can have logic modified but cannot be deleted
 *   (signature changes are allowed — new inputs/outputs are fine)
 * - Storage variables can be ADDED but not deleted or modified
 */

import type {
  ProgramABI,
  MappingABI,
  StructABI,
  RecordABI,
  TransitionABI,
  StorageVariableABI,
  StorageType,
  PlaintextType,
  StructFieldABI,
  RecordFieldABI,
} from "@lionden/leo-compiler";

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
export function checkAbiCompatibility(
  oldAbi: ProgramABI,
  newAbi: ProgramABI,
): AbiCompatResult {
  const violations: AbiViolation[] = [];

  // Check mappings
  checkNamedItems(
    oldAbi.mappings,
    newAbi.mappings,
    "mapping",
    compareMappings,
    violations,
    (m) => m.name,
  );

  // Check structs (keyed by full path to avoid module collisions)
  checkNamedItems(
    oldAbi.structs,
    newAbi.structs,
    "struct",
    compareStructs,
    violations,
    (s) => s.path.join("::"),
  );

  // Check records (keyed by full path to avoid module collisions)
  checkNamedItems(
    oldAbi.records,
    newAbi.records,
    "record",
    compareRecords,
    violations,
    (r) => r.path.join("::"),
  );

  // Check transitions (can only be deleted, not modified in signature)
  checkTransitions(oldAbi.transitions, newAbi.transitions, violations);

  // Check storage variables
  checkNamedItems(
    oldAbi.storage_variables,
    newAbi.storage_variables,
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

function checkTransitions(
  oldTransitions: readonly TransitionABI[],
  newTransitions: readonly TransitionABI[],
  violations: AbiViolation[],
): void {
  const newMap = new Map(newTransitions.map((t) => [t.name, t]));

  for (const oldT of oldTransitions) {
    if (!newMap.has(oldT.name)) {
      violations.push({
        kind: "transition_deleted",
        name: oldT.name,
        detail: `transition "${oldT.name}" was deleted`,
      });
    }
    // Transitions CAN have their signature/logic modified — no further checks
  }
}

function compareMappings(
  oldMapping: MappingABI,
  newMapping: MappingABI,
): string | null {
  if (!plaintextTypesEqual(oldMapping.key, newMapping.key)) {
    return `mapping "${oldMapping.name}" key type changed`;
  }
  if (!plaintextTypesEqual(oldMapping.value, newMapping.value)) {
    return `mapping "${oldMapping.name}" value type changed`;
  }
  return null;
}

function compareStructs(
  oldStruct: StructABI,
  newStruct: StructABI,
): string | null {
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

function compareRecords(
  oldRecord: RecordABI,
  newRecord: RecordABI,
): string | null {
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
  return (
    a.name === b.name &&
    a.mode === b.mode &&
    plaintextTypesEqual(a.ty, b.ty)
  );
}
