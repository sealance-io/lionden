const RECORD_DECLARATION_RE =
  /^\s*record\s+[A-Za-z_][A-Za-z0-9_]*\s*(?::|\{)/m;

/**
 * Detect static record declarations in Aleo/Leo-shaped source.
 *
 * Compiled `.aleo` artifacts use `record Name:`, while Leo source uses
 * `record Name {`. The deploy task normally passes compiled `.aleo`, but the
 * broader matcher keeps tests and direct helper calls honest.
 *
 * Precondition: callers pass compiled `.aleo` source (or trusted Leo source
 * authored by the project). Arbitrary untrusted content is not supported —
 * Aleo grammar has neither multi-line string literals nor block comments,
 * and the `^\s*` anchor rejects single-line comments (`// record Foo:`),
 * so false positives are not reachable through either source format.
 */
export function declaresStaticRecords(source: string): boolean {
  return RECORD_DECLARATION_RE.test(source);
}
