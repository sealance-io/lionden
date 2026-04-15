/**
 * Aleo address validation.
 *
 * Extracted here (zero deps) so both @lionden/config and @lionden/core
 * can validate address strings without importing from @lionden/network
 * or @lionden/plugin-deploy.
 */

/** Aleo address format: "aleo1" prefix followed by exactly 58 bech32 lowercase chars (a-z, 0-9). */
const ALEO_ADDRESS_RE = /^aleo1[a-z0-9]{58}$/;

/**
 * Returns true if `address` matches the Aleo bech32 address format.
 *
 * Validates:
 * - Prefix `aleo1`
 * - Exactly 58 lowercase alphanumeric (bech32 charset) characters after the prefix
 * - Total length of 64 characters
 */
export function isValidAleoAddress(address: string): boolean {
  return ALEO_ADDRESS_RE.test(address);
}
