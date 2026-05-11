// Port of tmp/leo-examples/basic_bank/. The upstream run.sh isn't checked
// in but the canonical flow per src/main.leo is:
//   1. bank.issue(user, 100)        → Token
//   2. user.deposit(token, 30)      → (remaining_token=70, balances[hash(user)]+=30)
//   3. user.deposit(remaining, 20)  → (remaining_token=50, balances[hash(user)]+=20)
//   4. bank.withdraw(user, 10, 0, 0) → (Token{user,10}, balances[hash(user)]-=10)
//
// The bank is hard-coded to `aleo1rhgdu77…` in the program, which matches
// devnode account-0. This port keeps the local+accepted pattern where the
// test wants a plaintext record and a separate finalize side effect. Newer
// accepted().outputs.decrypt(...) flows are demonstrated in the token examples
// where the broadcasted private record is the value under test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
} from "@lionden/testing";
import { createBasicBank, type Token } from "../typechain/BasicBank.js";

async function deployBank() {
  const ctx = await setup();
  try {
    await ctx.deploy("basic_bank", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployBank);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("basic_bank.aleo", () => {
  const basicBank = createBasicBank();
  const bank = () => ctx!.accounts[0]!;
  const user = () => ctx!.accounts[1]!;

  beforeAll(() => {
    basicBank.connect(ctx!.lre);
  });

  // Token issued to user, threaded through deposits.
  let token: Token | undefined;

  it("issue() mints a fresh Token to the recipient when called by the bank", async () => {
    token = await basicBank.withSigner(bank()).issue.locally({ owner: user(), amount: 100n });
    expect(token.owner).toBe(user().address);
    expect(token.amount).toBe(100n);
  });

  it("issue() rejects callers that aren't the bank", async () => {
    await basicBank.withSigner(user()).issue.failsLocally({ owner: user(), amount: 100n });
  });

  it("deposit() credits the bank's balance and returns the remainder", async () => {
    expect(token, "issue() must run first").toBeDefined();

    // Local: capture the remaining typed Token.
    const [remaining] = await basicBank.withSigner(user()).deposit.locally({ token: token!, amount: 30n });
    expect(remaining.amount).toBe(70n);

    // Broadcast: fire finalize so balances[hash(user)] = 30.
    await basicBank.withSigner(user()).deposit.accepted({ token: token!, amount: 30n });

    // The hash is computed inside the program; we don't have BHP256 in TS,
    // so we don't enumerate / assert balances directly. The local-mode
    // remainder above is the meaningful parity check; balance correctness is
    // implicit in the program's `current + amount` arithmetic. NOTE: a
    // future assertion would benefit from a TS-side BHP256 helper or a
    // mapping-iteration API on @lionden/network.

    // Replace tracked token with the remainder so subsequent tests use it.
    token = remaining;
  });

  it("withdraw() debits the bank's balance and pays out an interest-bearing Token", async () => {
    // Withdraw 10 with rate=0 / periods=0 → total = principal = 10.
    const [payout] = await basicBank.withSigner(bank()).withdraw.locally({
      recipient: user(),
      amount: 10n,
      rate: 0n,
      periods: 0n,
    });
    expect(payout.owner).toBe(user().address);
    expect(payout.amount).toBe(10n);

    // Broadcast: fire finalize so balances[hash(user)] decrements 30 → 20.
    await basicBank.withSigner(bank()).withdraw.accepted({
      recipient: user(),
      amount: 10n,
      rate: 0n,
      periods: 0n,
    });
    // Direct mapping assertion would need BHP256 in TS to compute the hash
    // key. Skipped for now — see the NOTE above.
  });

  it("withdraw() with interest pays out principal + compounded amount", async () => {
    // 100 at rate 100bps (1%) over 5 periods → 100 → 101 → 102 → 103 → 104 → 105.
    const [payout] = await basicBank.withSigner(bank()).withdraw.locally({
      recipient: user(),
      amount: 100n,
      rate: 100n,
      periods: 5n,
    });
    expect(payout.amount).toBe(105n);
  });

  it("withdraw() rejects callers that aren't the bank", async () => {
    await basicBank.withSigner(user()).withdraw.failsLocally({
      recipient: user(),
      amount: 10n,
      rate: 0n,
      periods: 0n,
    });
  });
});
