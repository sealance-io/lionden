import { vi } from "vitest";
import type { NetworkConnection } from "@lionden/network";
import { TEST_DEVNODE_EGRESS_POLICY } from "./test-egress-policy.js";

/**
 * Create a mock NetworkConnection with vi.fn() stubs for all methods.
 *
 * All methods return sensible defaults. Pass `overrides` to customize
 * individual fields or mock return values.
 *
 * @example
 * ```ts
 * // Default mock connection
 * const conn = createMockConnection();
 *
 * // Override a specific method
 * const conn = createMockConnection({
 *   getMappingValue: vi.fn().mockResolvedValue("100u64"),
 * });
 * ```
 */
export function createMockConnection(
  overrides: Partial<NetworkConnection> = {},
): NetworkConnection {
  return {
    type: "devnode",
    name: "devnode",
    endpoint: "http://127.0.0.1:3030",
    networkId: "testnet",
    egressPolicy: TEST_DEVNODE_EGRESS_POLICY,
    getBalance: vi.fn().mockResolvedValue(1000n),
    getMappingValue: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ outputs: ["1u32"], txId: "at1mock" }),
    waitForConfirmation: vi.fn().mockResolvedValue({
      txId: "at1mock",
      blockHeight: 10,
      status: "accepted",
      transitions: [],
    }),
    getTransitionOutputs: vi.fn().mockResolvedValue({
      outputs: ["1u32"],
      txId: "at1mock",
    }),
    getBlockHeight: vi.fn().mockResolvedValue(100),
    getProgramSource: vi.fn().mockResolvedValue(null),
    advanceBlocks: vi.fn().mockResolvedValue(undefined),
    broadcastTransaction: vi.fn().mockResolvedValue("at1mock"),
    close: vi.fn(),
    ...overrides,
  } as unknown as NetworkConnection;
}
