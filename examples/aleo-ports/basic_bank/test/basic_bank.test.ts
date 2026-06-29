// Port of tmp/leo-examples/basic_bank/. The upstream run.sh isn't checked
// in but the canonical flow per src/main.leo is:
//   1. bank.issue(user, 100)        → Token
//   2. user.deposit(token, 30)      → (remaining_token=70, balances[hash(user)]+=30)
//   3. user.deposit(remaining, 20)  → (remaining_token=50, balances[hash(user)]+=20)
//   4. bank.withdraw(user, 10, 0, 0) → (Token{user,10}, balances[hash(user)]-=10)
//
// The bank is hard-coded to `aleo1rhgdu77…` in the program, which matches
// devnode account-0. Transitions that finalize on chain are exercised through
// a single .accepted() call and their record outputs are recovered via
// confirmed.outputs.decrypt(account); proving needs the on-chain state paths,
// so we don't pre-run them in local mode. Local mode is reserved for pure
// parity checks (e.g. interest math) with no finalize side effect.

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    const confirmed = await basicBank.withSigner(bank()).issue.accepted(user(), 100n);
    token = await confirmed.outputs.decrypt(user());
    expect(token.owner).toBe(user().address);
    expect(token.amount).toBe(100n);
  });

  it("issue() rejects callers that aren't the bank", async () => {
    await basicBank.withSigner(user()).issue.failsLocally(user(), 100n);
  });

  it("deposit() credits the bank's balance and returns the remainder", async () => {
    expect(token, "issue() must run first").toBeDefined();

    // Broadcast: spend the real on-chain record and fire finalize so
    // balances[hash(user)] = 30. The remainder Token comes off the accepted
    // transition so subsequent on-chain spends use a record that exists on
    // chain. The hash is computed inside the program; we don't have BHP256 in
    // TS, so we don't enumerate / assert balances directly. NOTE: a future
    // assertion would benefit from a TS-side BHP256 helper or a
    // mapping-iteration API on @lionden/network.
    const confirmed = await basicBank.withSigner(user()).deposit.accepted(token!, 30n);
    const remaining = await confirmed.outputs.decrypt(user());
    expect(remaining.amount).toBe(70n);

    token = remaining;
  });

  it("withdraw() debits the bank's balance and pays out an interest-bearing Token", async () => {
    // Withdraw 10 with rate=0 / periods=0 → total = principal = 10.
    // Broadcast fires finalize so balances[hash(user)] decrements 30 → 20.
    // Direct mapping assertion would need BHP256 in TS to compute the hash
    // key. Skipped for now — see the NOTE above.
    const confirmed = await basicBank.withSigner(bank()).withdraw.accepted(user(), 10n, 0n, 0n);
    const payout = await confirmed.outputs.decrypt(user());
    expect(payout.owner).toBe(user().address);
    expect(payout.amount).toBe(10n);
  });

  it("withdraw() with interest pays out principal + compounded amount", async () => {
    // 100 at rate 100bps (1%) over 5 periods → 100 → 101 → 102 → 103 → 104 → 105.
    const [payout] = await basicBank.withSigner(bank()).withdraw.locally(user(), 100n, 100n, 5n);
    expect(payout.amount).toBe(105n);
  });

  it("withdraw() rejects callers that aren't the bank", async () => {
    await basicBank.withSigner(user()).withdraw.failsLocally(user(), 10n, 0n, 0n);
  });
});
