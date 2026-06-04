/**
 * ABI compatibility checker for program upgrades.
 *
 * Rules (per Leo v4 / ARC-0006 upgrade spec):
 * - Mappings can be ADDED but not deleted or modified (key/value types must match)
 * - Structs can be ADDED but not deleted or modified (fields must match exactly)
 * - Records can be ADDED but not deleted or modified (fields must match exactly)
 * - Transitions can be ADDED; existing transitions cannot be deleted and their
 *   input/output signatures must remain unchanged (logic-only changes are fine)
 * - Views can be ADDED; existing views cannot be deleted and their signatures
 *   must remain unchanged
 * - Implemented interfaces can be ADDED; existing interface refs cannot be
 *   deleted or modified
 * - Storage variables can be ADDED but not deleted or modified
 */

import type {
  AbiInput,
  AbiOutput,
  AleoType,
  InterfaceRefABI,
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
    | "interface_deleted"
    | "interface_modified"
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
  checkNamedItems(oldAbi.structs, newAbi.structs, "struct", compareStructs, violations, (s) =>
    s.path.join("::"),
  );

  // Check records (keyed by full path to avoid module collisions)
  checkNamedItems(oldAbi.records, newAbi.records, "record", compareRecords, violations, (r) =>
    r.path.join("::"),
  );

  // Check transitions (can be added; cannot be deleted or have signature modified)
  checkNamedItems(
    oldAbi.transitions,
    newAbi.transitions,
    "transition",
    compareTransitionSignatures,
    violations,
    (t) => t.name,
  );

  checkNamedItems(
    oldAbi.views ?? [],
    newAbi.views ?? [],
    "view",
    compareViewSignatures,
    violations,
    (view) => view.name,
  );

  checkNamedItems(
    oldAbi.implements ?? [],
    newAbi.implements ?? [],
    "interface",
    compareInterfaceRefs,
    violations,
    interfaceRefKey,
  );

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
      return `transition "${oldT.name}" input "${oldIn.name}" changed`;
    }
  }
  for (let i = 0; i < oldT.outputs.length; i++) {
    const oldOut = oldT.outputs[i]!;
    const newOut = newT.outputs[i]!;
    if (!transitionOutputsEqual(oldOut, newOut)) {
      return `transition "${oldT.name}" output[${i}] changed`;
    }
  }
  if (JSON.stringify(oldT.const_parameters ?? []) !== JSON.stringify(newT.const_parameters ?? [])) {
    return `transition "${oldT.name}" const parameters changed`;
  }
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
      return `view "${oldView.name}" input "${oldIn.name}" changed`;
    }
  }
  for (let i = 0; i < oldView.outputs.length; i++) {
    const oldOut = oldView.outputs[i]!;
    const newOut = newView.outputs[i]!;
    if (!transitionOutputsEqual(oldOut, newOut)) {
      return `view "${oldView.name}" output[${i}] changed`;
    }
  }
  if (
    JSON.stringify(oldView.const_parameters ?? []) !==
    JSON.stringify(newView.const_parameters ?? [])
  ) {
    return `view "${oldView.name}" const parameters changed`;
  }
  return null;
}

function compareInterfaceRefs(oldRef: InterfaceRefABI, newRef: InterfaceRefABI): string | null {
  if (
    JSON.stringify(canonicalInterfaceRef(oldRef)) !== JSON.stringify(canonicalInterfaceRef(newRef))
  ) {
    return `interface "${interfaceRefKey(oldRef)}" changed`;
  }
  return null;
}

function interfaceRefKey(ref: InterfaceRefABI): string {
  return typeof ref === "string" ? ref : ref.path.join("::");
}

function canonicalInterfaceRef(ref: InterfaceRefABI): unknown {
  return typeof ref === "string" ? ref : { path: ref.path, program: ref.program ?? null };
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
  return a.name === b.name && a.mode === b.mode && aleoTypesEqual(a.ty, b.ty);
}

function transitionOutputsEqual(a: AbiOutput, b: AbiOutput): boolean {
  return a.mode === b.mode && aleoTypesEqual(a.ty, b.ty);
}
