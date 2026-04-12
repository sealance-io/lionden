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
      "APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH",
    address:
      "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px",
    initialBalance: 23_437_500_000_000n,
  },
  {
    name: "account-1",
    privateKey:
      "APrivateKey1zkp2RWGDcde3efb89rjhME1VYA8QMxcxep5DShNBR6n8Yjh",
    address:
      "aleo1s3ws5tra87fjycnjrwsjcrnw2qxr8jfqqdugnf0xzqqw29q9m5pqem2u4t",
    initialBalance: 23_437_500_000_000n,
  },
  {
    name: "account-2",
    privateKey:
      "APrivateKey1zkp2GUmKbVsuc1NSj28pa1WTQuZaK5f1DQJAT6vPcHyWokG",
    address:
      "aleo1ashyu96tjwe63u0gtnnv8z5lhapdu4l5pjsl2kha7fv7hvz2eqxs5dz0rg",
    initialBalance: 23_437_500_000_000n,
  },
  {
    name: "account-3",
    privateKey:
      "APrivateKey1zkpBjpEgLo4arVUkQmcLdKQMiAKGaHAQVVwmF8HQby8vdYs",
    address:
      "aleo12ux3gdauck0v60westgcpqj7v8rrcr3v346e4jtq04q7kkt22czsh808v2",
    initialBalance: 23_437_500_000_000n,
  },
] as const;

/**
 * Get the default devnode signer account (account-0).
 */
export function getDefaultAccount(): DevnodeAccount {
  return DEVNODE_ACCOUNTS[0]!;
}
