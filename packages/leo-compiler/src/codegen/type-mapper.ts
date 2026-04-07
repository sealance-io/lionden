import type { AleoType, PlaintextType, PrimitiveType } from "../abi-types.js";

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
      case "Scalar": return "string";
    }
  }

  if ("UInt" in prim) {
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

  if ("Int" in prim) {
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
  if ("Struct" in pt) return pt.Struct;
  if ("Array" in pt) {
    const [elemType, _size] = pt.Array;
    return `${plaintextToTs(elemType)}[]`;
  }
  return "unknown";
}

/**
 * Map a top-level AleoType to its TypeScript representation.
 */
export function aleoTypeToTs(ty: AleoType): string {
  if ("Plaintext" in ty) return plaintextToTs(ty.Plaintext);
  if ("Record" in ty) return ty.Record;
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
      case "Scalar": return "scalar";
    }
  }

  if ("UInt" in prim) return prim.UInt.toLowerCase();
  if ("Int" in prim) return prim.Int.toLowerCase();

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
