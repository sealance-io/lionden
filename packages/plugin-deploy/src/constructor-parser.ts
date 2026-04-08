/**
 * Parse Leo v4 source files for ARC-0006 constructor annotations.
 *
 * Leo v4 supports three constructor forms:
 *   - `@noupgrade`                    — program cannot be upgraded after deployment
 *   - `@admin(address="aleo1...")`    — only the specified address can upgrade
 *   - `@custom`                       — custom constructor logic evaluated on-chain
 *
 * The annotation appears on a `constructor` function:
 *   @noupgrade
 *   fn constructor() { ... }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConstructorType = "noupgrade" | "admin" | "custom";

export interface ConstructorInfo {
  readonly type: ConstructorType;
  /** The admin address, only present when type === "admin" */
  readonly adminAddress?: string;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Match @noupgrade annotation followed (possibly after whitespace/comments) by constructor fn
const NOUPGRADE_RE =
  /@noupgrade\s+(?:\/\/[^\n]*\n\s*)*fn\s+constructor\s*\(/;

// Match @admin(address="...") followed by constructor fn
const ADMIN_RE =
  /@admin\s*\(\s*address\s*=\s*"([^"]+)"\s*\)\s+(?:\/\/[^\n]*\n\s*)*fn\s+constructor\s*\(/;

// Match @custom annotation followed by constructor fn
const CUSTOM_RE =
  /@custom\s+(?:\/\/[^\n]*\n\s*)*fn\s+constructor\s*\(/;

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
// Helpers
// ---------------------------------------------------------------------------

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}
