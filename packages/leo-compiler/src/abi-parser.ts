import type { ProgramABI } from "./abi-types.js";

export class AbiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbiParseError";
  }
}

/**
 * Parse a JSON ABI string into a typed ProgramABI structure.
 * Validates required fields and basic structure.
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

  // Validate top-level arrays exist (may be empty)
  const abi: ProgramABI = {
    program: obj["program"] as string,
    structs: asArray(obj["structs"], "structs"),
    records: asArray(obj["records"], "records"),
    mappings: asArray(obj["mappings"], "mappings"),
    storage_variables: asArray(obj["storage_variables"], "storage_variables"),
    transitions: asArray(obj["transitions"], "transitions"),
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

function asArray<T>(value: unknown, fieldName: string): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AbiParseError(`"${fieldName}" must be an array`);
  }
  return value as T[];
}
