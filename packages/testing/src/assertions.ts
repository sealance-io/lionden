/**
 * Aleo-specific test assertions.
 *
 * These are standalone assertion functions that throw on failure,
 * designed to work with any test runner (Vitest, Jest, etc.).
 */

import type { NetworkConnection } from "@lionden/network";

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

// ---------------------------------------------------------------------------
// Mapping assertions
// ---------------------------------------------------------------------------

/**
 * Assert that a mapping entry has the expected value.
 *
 * ```typescript
 * await assertMappingValue(connection, "token.aleo", "balances", key, "100u64");
 * ```
 */
export async function assertMappingValue(
  connection: NetworkConnection,
  programId: string,
  mappingName: string,
  key: string,
  expectedValue: string,
): Promise<void> {
  const actual = await connection.getMappingValue(programId, mappingName, key);

  if (actual === null) {
    throw new AssertionError(
      `Expected ${programId}/${mappingName}[${key}] to be "${expectedValue}", ` +
        `but the key has no entry.`,
    );
  }

  // Normalize whitespace for comparison
  const normalizedActual = actual.trim();
  const normalizedExpected = expectedValue.trim();

  if (normalizedActual !== normalizedExpected) {
    throw new AssertionError(
      `Expected ${programId}/${mappingName}[${key}] to be "${normalizedExpected}", ` +
        `but got "${normalizedActual}".`,
    );
  }
}

/**
 * Assert that a mapping key has no entry (is null/unset).
 */
export async function assertMappingEmpty(
  connection: NetworkConnection,
  programId: string,
  mappingName: string,
  key: string,
): Promise<void> {
  const actual = await connection.getMappingValue(programId, mappingName, key);

  if (actual !== null) {
    throw new AssertionError(
      `Expected ${programId}/${mappingName}[${key}] to have no entry, ` +
        `but got "${actual}".`,
    );
  }
}

// ---------------------------------------------------------------------------
// Transaction assertions
// ---------------------------------------------------------------------------

/**
 * Assert that a transaction was confirmed (accepted) on-chain.
 */
export async function assertTransactionConfirmed(
  connection: NetworkConnection,
  txId: string,
  timeout?: number,
): Promise<void> {
  const confirmed = await connection.waitForConfirmation(txId, timeout);

  if (confirmed.status !== "accepted") {
    throw new AssertionError(
      `Expected transaction ${txId} to be accepted, ` +
        `but it was ${confirmed.status}.`,
    );
  }
}

/**
 * Assert that a transaction was rejected on-chain.
 */
export async function assertTransactionRejected(
  connection: NetworkConnection,
  txId: string,
  timeout?: number,
): Promise<void> {
  const confirmed = await connection.waitForConfirmation(txId, timeout);

  if (confirmed.status !== "rejected") {
    throw new AssertionError(
      `Expected transaction ${txId} to be rejected, ` +
        `but it was ${confirmed.status}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Balance assertions
// ---------------------------------------------------------------------------

/**
 * Assert that an account has at least the specified balance (in microcredits).
 */
export async function assertBalanceAtLeast(
  connection: NetworkConnection,
  address: string,
  minBalance: bigint,
): Promise<void> {
  const actual = await connection.getBalance(address);

  if (actual < minBalance) {
    throw new AssertionError(
      `Expected balance of ${address} to be at least ${minBalance} microcredits, ` +
        `but got ${actual}.`,
    );
  }
}

/**
 * Assert that an account has exactly the specified balance (in microcredits).
 */
export async function assertBalance(
  connection: NetworkConnection,
  address: string,
  expectedBalance: bigint,
): Promise<void> {
  const actual = await connection.getBalance(address);

  if (actual !== expectedBalance) {
    throw new AssertionError(
      `Expected balance of ${address} to be ${expectedBalance} microcredits, ` +
        `but got ${actual}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Block height assertions
// ---------------------------------------------------------------------------

/**
 * Assert that the block height is at least the specified value.
 */
export async function assertBlockHeightAtLeast(
  connection: NetworkConnection,
  minHeight: number,
): Promise<void> {
  const actual = await connection.getBlockHeight();

  if (actual < minHeight) {
    throw new AssertionError(
      `Expected block height to be at least ${minHeight}, but got ${actual}.`,
    );
  }
}
