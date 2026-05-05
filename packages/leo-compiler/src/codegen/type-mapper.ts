import type { AleoType, PlaintextType, PrimitiveType, StructRef, RecordRef } from "../abi-types.js";

/**
 * Convert a path (from a StructRef, RecordRef, or declaration) to a
 * collision-free TypeScript identifier.
 *
 * Single segment: `["Foo"]` → `"Foo"` (unchanged).
 * Multi-segment:  `["utils", "Vector3"]` → `"Utils_Vector3"`.
 */
export function pathToTsName(path: readonly string[]): string {
  if (path.length === 1) return path[0]!;
  return path.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("_");
}

/**
 * Derive the TypeScript name for a StructRef.
 */
export function structRefName(ref: StructRef): string {
  return pathToTsName(ref.path);
}

/**
 * Derive the TypeScript name for a RecordRef.
 */
export function recordRefName(ref: RecordRef): string {
  return pathToTsName(ref.path);
}

/**
 * Map a Leo/Aleo primitive type to its TypeScript representation.
 */
export function primitiveToTs(prim: PrimitiveType): string {
  if (typeof prim === "string") {
    switch (prim) {
      case "Address": return "string";
      case "Boolean": return "boolean";
      case "Field": return "string";
      case "Group": return "string";
      case "Identifier": return "string";
      case "Scalar": return "string";
    }
    return "unknown";
  }

  if (typeof prim === "object" && prim !== null && "UInt" in prim) {
    switch (prim.UInt) {
      case "U8":
      case "U16":
      case "U32":
        return "number";
      case "U64":
      case "U128":
        return "bigint";
    }
  }

  if (typeof prim === "object" && prim !== null && "Int" in prim) {
    switch (prim.Int) {
      case "I8":
      case "I16":
      case "I32":
        return "number";
      case "I64":
      case "I128":
        return "bigint";
    }
  }

  return "unknown";
}

/**
 * Map a PlaintextType to its TypeScript representation.
 */
export function plaintextToTs(pt: PlaintextType): string {
  if ("Primitive" in pt) return primitiveToTs(pt.Primitive);
  if ("Struct" in pt) return structRefName(pt.Struct);
  if ("Array" in pt) {
    const [elemType, _size] = pt.Array;
    return `${plaintextToTs(elemType)}[]`;
  }
  if ("Optional" in pt) return `${plaintextToTs(pt.Optional)} | null`;
  return "unknown";
}

/**
 * Map a top-level AleoType to its TypeScript representation.
 */
export function aleoTypeToTs(ty: AleoType): string {
  if (ty === "DynamicRecord") return "string";
  if ("Plaintext" in ty) return plaintextToTs(ty.Plaintext);
  if ("Record" in ty) return recordRefName(ty.Record);
  if ("Future" in ty) return "void";
  return "unknown";
}

/**
 * Get the Leo type suffix for a primitive (used in serialization).
 * e.g. "u64", "field", "address", "bool"
 */
export function primitiveToLeoSuffix(prim: PrimitiveType): string {
  if (typeof prim === "string") {
    switch (prim) {
      case "Address": return "address";
      case "Boolean": return "bool";
      case "Field": return "field";
      case "Group": return "group";
      case "Identifier": return "identifier";
      case "Scalar": return "scalar";
    }
    return "unknown";
  }

  if (typeof prim === "object" && prim !== null && "UInt" in prim) return prim.UInt.toLowerCase();
  if (typeof prim === "object" && prim !== null && "Int" in prim) return prim.Int.toLowerCase();

  return "unknown";
}

/**
 * Check if a primitive type should be serialized with a suffix.
 * Address, Field, Group, Scalar are passed as raw strings.
 * Integers need the suffix (e.g., "100u64").
 * Boolean needs no suffix in Leo string form.
 */
export function needsSuffix(prim: PrimitiveType): boolean {
  if (typeof prim === "string") {
    return prim === "Boolean"; // "true" / "false" — no suffix needed
  }
  return true; // integers always need suffix
}

/**
 * Check if a type uses bigint in TS (needs BigInt serialization).
 */
export function isBigIntType(prim: PrimitiveType): boolean {
  if (typeof prim === "object") {
    if ("UInt" in prim) return prim.UInt === "U64" || prim.UInt === "U128";
    if ("Int" in prim) return prim.Int === "I64" || prim.Int === "I128";
  }
  return false;
}
