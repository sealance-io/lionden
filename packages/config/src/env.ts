const TRUE_TOKENS = new Set(["true", "t", "yes", "y", "1", "on", "enabled"]);
const FALSE_TOKENS = new Set(["false", "f", "no", "n", "0", "off", "disabled"]);

/**
 * Parse a boolean-ish environment value. Accepts common truthy/falsy spellings
 * (case-insensitive, trimmed). Unknown values fall back to `defaultValue` and
 * invoke `onInvalid` (if given) so the *caller* decides whether/how to warn —
 * the parser never writes to console (avoids worker/wrapper noise).
 *
 * `defaultValue` is `false` so an unset env reads as "not proving"; every prove
 * call site relies on this.
 */
export function parseBooleanEnv(
  value: string | undefined,
  defaultValue = false,
  onInvalid?: (value: string) => void,
): boolean {
  if (value === undefined || value === "") return defaultValue;
  const v = value.toLowerCase().trim();
  if (TRUE_TOKENS.has(v)) return true;
  if (FALSE_TOKENS.has(v)) return false;
  onInvalid?.(value);
  return defaultValue;
}
