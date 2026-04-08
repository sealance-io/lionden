/**
 * Test fixture management.
 *
 * Implements the `loadFixture(fn)` pattern for caching expensive
 * test setup (e.g., program deployments). When multiple tests share
 * the same fixture function, it is only executed once; subsequent
 * calls return the cached result.
 *
 * Since devnode has no snapshot/revert, fixture caching is the primary
 * mechanism for test setup reuse within a suite.
 */

// Cache: fixture function reference → { result, promise }
const fixtureCache = new Map<
  FixtureFn<unknown>,
  { result?: unknown; promise?: Promise<unknown> }
>();

/**
 * A fixture function receives the test context and returns setup state.
 * It should be idempotent — the framework may cache its result.
 */
export type FixtureFn<T> = () => Promise<T>;

/**
 * Load a fixture, executing it only once per test suite.
 *
 * The fixture function is identified by reference equality — pass the
 * same function object to get the cached result.
 *
 * ```typescript
 * async function deployToken() {
 *   const ctx = await setup();
 *   const token = await ctx.deploy("token");
 *   return { ctx, token };
 * }
 *
 * it("mints tokens", async () => {
 *   const { ctx, token } = await loadFixture(deployToken);
 *   // ...
 * });
 * ```
 */
export async function loadFixture<T>(fn: FixtureFn<T>): Promise<T> {
  const cached = fixtureCache.get(fn as FixtureFn<unknown>);

  if (cached) {
    if ("result" in cached && cached.result !== undefined) {
      return cached.result as T;
    }
    if (cached.promise) {
      return (await cached.promise) as T;
    }
  }

  const entry: { result?: unknown; promise?: Promise<unknown> } = {};
  fixtureCache.set(fn as FixtureFn<unknown>, entry);

  const promise = fn();
  entry.promise = promise as Promise<unknown>;

  const result = await promise;
  entry.result = result;
  delete entry.promise;

  return result;
}

/**
 * Clear all cached fixtures.
 * Call this in afterAll to ensure a clean slate for the next suite.
 */
export function clearFixtures(): void {
  fixtureCache.clear();
}
