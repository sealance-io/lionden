// LRE factory (auto-discovers config and creates HRE for test files)
export { createTestLre, resetTestLre } from "./lre-factory.js";

// Test context
export { setup } from "./test-context.js";
export type {
  TestContext,
  SetupOptions,
  DeployOptions,
  DeployResult,
  ExecuteOptions,
  ExecuteResult,
} from "./test-context.js";

// Devnode lifecycle
export { startDevnode, stopDevnode } from "./devnode-lifecycle.js";
export type { ManagedDevnode } from "./devnode-lifecycle.js";

// Fixtures
export { loadFixture, clearFixtures } from "./fixtures.js";
export type { FixtureFn } from "./fixtures.js";

// Assertions
export {
  AssertionError,
  assertMappingValue,
  assertMappingEmpty,
  assertTransactionConfirmed,
  assertTransactionRejected,
  assertBalanceAtLeast,
  assertBalance,
  assertBlockHeightAtLeast,
} from "./assertions.js";

// Accounts (re-export for convenience)
export {
  DEVNODE_ACCOUNTS,
  getDefaultAccount,
  getAccount,
  getAddresses,
  getAccountByAddress,
} from "./accounts.js";
