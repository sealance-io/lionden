// Port of tmp/leo-examples/token/. Two-actor demo (alice, bob) exercising
// the four mint/transfer combinations: mint_public, mint_private,
// transfer_public, transfer_private, transfer_public_to_private,
// transfer_private_to_public.
//
// Patterns used here:
//   - Pure transitions with no finalize side effect (mint_private parity,
//     transfer_private) → typed local-mode call.
//   - Final-only (mint_public, transfer_public) → accepted(); assert
//     mapping after via typed mappings.account.get(addr).
//   - Mixed transitions that finalize on chain are exercised through a single
//     accepted() call, recovering record outputs with
//     confirmed.outputs.decrypt(...). Proving needs the on-chain state paths,
//     so we don't pre-run them in local mode.

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenContract } from "../typechain/Token.js";

async function deployToken() {
  const ctx = await setup();
  try {
    await ctx.deploy("token", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployToken);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("token.aleo", () => {
  const token = createTokenContract();
  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    token.connect(ctx!.lre);
  });

  it("mint_public increments account[receiver]", async () => {
    await token.withSigner(alice()).mint_public.accepted(alice(), 100n);
    expect(await token.mappings.account.get(alice())).toBe(100n);
  });

  it("mint_private returns a Token record (no mapping side effect)", async () => {
    const minted = await token.withSigner(bob()).mint_private.locally(bob(), 100n);
    expect(minted.owner).toBe(bob().address);
    expect(minted.amount).toBe(100n);
  });

  it("transfer_public moves balance between accounts", async () => {
    // alice has 100 from earlier mint_public. Send 10 to bob.
    await token.withSigner(alice()).transfer_public.accepted(bob(), 10n);
    expect(await token.mappings.account.get(alice())).toBe(90n);
    expect(await token.mappings.account.get(bob())).toBe(10n);
  });

  it("transfer_private splits a Token into (remainder, transferred)", async () => {
    // Mint a fresh private token to bob in local mode.
    const bobToken = await token.withSigner(bob()).mint_private.locally(bob(), 100n);

    // Bob splits 30 to alice.
    const [remaining, transferred] = await token
      .withSigner(bob())
      .transfer_private.locally(bobToken, alice(), 30n);

    expect(remaining.owner).toBe(bob().address);
    expect(remaining.amount).toBe(70n);
    expect(transferred.owner).toBe(alice().address);
    expect(transferred.amount).toBe(30n);
  });

  it("transfer_private_to_public yields a remainder Token + bumps account[receiver]", async () => {
    // Mint a private Token to bob on chain so the proven transfer below has a
    // record with a valid state path to spend.
    const minted = await token.withSigner(bob()).mint_private.accepted(bob(), 50n);
    const bobToken = await minted.outputs.decrypt(bob());

    // Broadcast: fire finalize → account[alice] += 20.
    // alice had 90 (after prior transfer_public). After this: 110.
    const confirmed = await token
      .withSigner(bob())
      .transfer_private_to_public.accepted(bobToken, alice(), 20n);
    const remainder = await confirmed.outputs.decrypt(bob());
    expect(remainder.owner).toBe(bob().address);
    expect(remainder.amount).toBe(30n);
    expect(await token.mappings.account.get(alice())).toBe(110n);
  });

  it("transfer_public_to_private emits a private Token + decrements account[caller]", async () => {
    // alice has 110. Transfer 40 to bob (privately).
    const confirmed = await token
      .withSigner(alice())
      .transfer_public_to_private.accepted(bob(), 40n);

    expect(confirmed.outputs.ciphertext).toMatch(/^record1/);
    expect(confirmed.rawOutputs[0]).toBe(confirmed.outputs.ciphertext);

    const recvToken = await confirmed.outputs.decrypt(bob());
    expect(recvToken.owner).toBe(bob().address);
    expect(recvToken.amount).toBe(40n);

    expect(await token.mappings.account.get(alice())).toBe(70n);
  });
});
