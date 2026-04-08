import type { DevnodeAccount } from "./types.js";

/**
 * Well-known devnode genesis accounts.
 * These are the deterministic accounts provisioned by `leo devnode start`
 * with ~23.4375 trillion microcredits each.
 */
export const DEVNODE_ACCOUNTS: readonly DevnodeAccount[] = [
  {
    name: "account-0",
    privateKey:
      "APrivateKey1zkp8CZNn3yeCBJ4tRPqpQMBR5Qn3ZjYkBEQR6VcX3v7t7QE",
    address:
      "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    initialBalance: 23_437_500_000_000n,
  },
  {
    name: "account-1",
    privateKey:
      "APrivateKey1zkp2oJEHp9DFAoQhLMZ8v8nUFvYEhyB8WLQ3NKeSDgA8vDE",
    address:
      "aleo1s3ws5tra87fjycnjrwsjcrnw2qz7vrcqa96naxdzj0tpv3qvqugqxk6rn0",
    initialBalance: 23_437_500_000_000n,
  },
  {
    name: "account-2",
    privateKey:
      "APrivateKey1zkp2NWR6o3UvpFCyFBXJTKszQ7v7JoqAmeJLe3RZCGsYj4V",
    address:
      "aleo15g9c69urtdhvfml0z22l6c3hmk37mnwlhgr3pyd2dp0ry305v5ys382l8y",
    initialBalance: 23_437_500_000_000n,
  },
  {
    name: "account-3",
    privateKey:
      "APrivateKey1zkpBg3hzYdTJHzNEE5x7zhT5WUqN4e6ciMiyiZs5Fq3Y2Mx",
    address:
      "aleo1ashyu96tjwe63u0gtnnhsvlkynxe37en4kw8r2dn6w5e2c42z58qhwa4df",
    initialBalance: 23_437_500_000_000n,
  },
] as const;

/**
 * Get the default devnode signer account (account-0).
 */
export function getDefaultAccount(): DevnodeAccount {
  return DEVNODE_ACCOUNTS[0]!;
}
