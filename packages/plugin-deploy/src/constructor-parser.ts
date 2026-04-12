/**
 * Parse Leo v4 source files for ARC-0006 constructor annotations.
 *
 * Leo v4 supports four constructor forms:
 *   - `@noupgrade`                                         — program cannot be upgraded after deployment
 *   - `@admin(address="aleo1...")`                         — only the specified address can upgrade
 *   - `@checksum(mapping="prog.aleo::map", key="value")`   — upgrade governed by on-chain checksum in external mapping
 *   - `@custom`                                            — custom constructor logic evaluated on-chain
 *
 * The annotation appears on a `constructor` function:
 *   @noupgrade
 *   constructor() { ... }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConstructorType = "noupgrade" | "admin" | "checksum" | "custom";

export interface ConstructorInfo {
  readonly type: ConstructorType;
  /** The admin address, only present when type === "admin" */
  readonly adminAddress?: string;
  /** External mapping reference, only present when type === "checksum" */
  readonly checksumMapping?: string;
  /** Mapping key for checksum lookup, only present when type === "checksum" */
  readonly checksumKey?: string;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Match @noupgrade annotation followed (possibly after whitespace/comments) by constructor
const NOUPGRADE_RE =
  /@noupgrade\s+(?:\/\/[^\n]*\n\s*)*constructor\s*\(/;

// Match @admin(address="...") followed by constructor
const ADMIN_RE =
  /@admin\s*\(\s*address\s*=\s*"([^"]+)"\s*\)\s+(?:\/\/[^\n]*\n\s*)*constructor\s*\(/;

// Match @checksum(mapping="...", key="...") followed by constructor
const CHECKSUM_RE =
  /@checksum\s*\(\s*mapping\s*=\s*"([^"]+)"\s*,\s*key\s*=\s*"([^"]+)"\s*\)\s+(?:\/\/[^\n]*\n\s*)*constructor\s*\(/;

// Match @custom annotation followed by constructor
const CUSTOM_RE =
  /@custom\s+(?:\/\/[^\n]*\n\s*)*constructor\s*\(/;

// Aleo address format: aleo1 followed by 58 bech32 characters
const ALEO_ADDRESS_RE = /^aleo1[a-z0-9]{58}$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse Leo source code for a constructor annotation.
 * Returns the constructor info if found, or null if no constructor is present.
 *
 * @param leoSource - The full Leo source code (may be from one or multiple files concatenated)
 */
export function parseConstructor(leoSource: string): ConstructorInfo | null {
  // Strip block comments to avoid false positives
  const stripped = stripBlockComments(leoSource);

  // Try @admin first (most specific pattern)
  const adminMatch = ADMIN_RE.exec(stripped);
  if (adminMatch) {
    const address = adminMatch[1]!;
    return { type: "admin", adminAddress: address };
  }

  // Try @checksum (more specific than @custom, so check first)
  const checksumMatch = CHECKSUM_RE.exec(stripped);
  if (checksumMatch) {
    return {
      type: "checksum",
      checksumMapping: checksumMatch[1]!,
      checksumKey: checksumMatch[2]!,
    };
  }

  // Try @noupgrade
  if (NOUPGRADE_RE.test(stripped)) {
    return { type: "noupgrade" };
  }

  // Try @custom
  if (CUSTOM_RE.test(stripped)) {
    return { type: "custom" };
  }

  return null;
}

/**
 * Validate that an admin address is a well-formed Aleo address.
 */
export function isValidAleoAddress(address: string): boolean {
  return ALEO_ADDRESS_RE.test(address);
}

/**
 * Parse constructor from multiple Leo source files (all files in a program).
 * Only one constructor should exist per program — returns the first found,
 * or null if none.
 */
export function parseConstructorFromFiles(
  sources: readonly string[],
): ConstructorInfo | null {
  for (const source of sources) {
    const result = parseConstructor(source);
    if (result) return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compiled Aleo constructor fingerprint
// ---------------------------------------------------------------------------

/**
 * Extract a constructor fingerprint from compiled Aleo source.
 *
 * For compiler-managed modes (`admin`, `noupgrade`, `checksum`), the
 * edition assertion is stripped since the compiler auto-increments it
 * on each upgrade. For `custom` mode, the full constructor body is
 * compared verbatim — any `assert.eq edition` there is user-authored
 * immutable logic, not compiler-generated.
 *
 * Returns an empty string when the constructor only contains the
 * edition assertion, or when no constructor section is found.
 */
export function extractConstructorFingerprint(
  aleoSource: string,
  constructorType?: ConstructorType,
): string {
  const match = /\nconstructor:\n([\s\S]+)$/.exec(aleoSource);
  if (!match) return "";

  const lines = match[1]!
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // For @custom, compare the entire constructor body verbatim —
  // any edition assertion is user-authored immutable logic.
  if (constructorType === "custom") {
    return lines.join("\n");
  }

  // For compiler-managed modes, strip the edition assertion
  // (auto-incremented by the compiler on each upgrade).
  return lines
    .filter((l) => !l.startsWith("assert.eq edition"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}
