// Port of tmp/leo-examples/token/. Two-actor demo (alice, bob) exercising
// the four mint/transfer combinations: mint_public, mint_private,
// transfer_public, transfer_private, transfer_public_to_private,
// transfer_private_to_public.
//
// Patterns used here:
//   - Pure transitions (mint_private, transfer_private) → typed local-mode call.
//   - Final-only (mint_public, transfer_public) → accepted(); assert
//     mapping after via typed getAccount(addr).
//   - Mixed transitions can either use local mode for plaintext previews, or
//     accepted().rawOutputs + decryptToken(...) when the broadcasted record is
//     the output that needs to be chained/asserted.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
} from "@lionden/testing";
import { createTokenContract, decryptToken } from "../typechain/Token.js";

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
    await token.withSigner(alice()).mint_public.accepted({ receiver: alice(), amount: 100n });
    expect(await token.getAccount(alice())).toBe(100n);
  });

  it("mint_private returns a Token record (no mapping side effect)", async () => {
    const minted = await token.withSigner(bob()).mint_private.locally({ receiver: bob(), amount: 100n });
    expect(minted.owner).toBe(bob().address);
    expect(minted.amount).toBe(100n);
  });

  it("transfer_public moves balance between accounts", async () => {
    // alice has 100 from earlier mint_public. Send 10 to bob.
    await token.withSigner(alice()).transfer_public.accepted({ receiver: bob(), amount: 10n });
    expect(await token.getAccount(alice())).toBe(90n);
    expect(await token.getAccount(bob())).toBe(10n);
  });

  it("transfer_private splits a Token into (remainder, transferred)", async () => {
    // Mint a fresh private token to bob in local mode.
    const bobToken = await token.withSigner(bob()).mint_private.locally({ receiver: bob(), amount: 100n });

    // Bob splits 30 to alice.
    const [remaining, transferred] = await token
      .withSigner(bob())
      .transfer_private.locally({ sender: bobToken, receiver: alice(), amount: 30n });

    expect(remaining.owner).toBe(bob().address);
    expect(remaining.amount).toBe(70n);
    expect(transferred.owner).toBe(alice().address);
    expect(transferred.amount).toBe(30n);
  });

  it("transfer_private_to_public yields a remainder Token + bumps account[receiver]", async () => {
    // Mint a fresh 50-token to bob (private) — mint_private is pure, ok in local.
    const bobToken = await token.withSigner(bob()).mint_private.locally({ receiver: bob(), amount: 50n });

    // Local: capture remainder Token plaintext.
    const [remainder] = await token
      .withSigner(bob())
      .transfer_private_to_public.locally({ sender: bobToken, receiver: alice(), amount: 20n });
    expect(remainder.amount).toBe(30n);

    // Broadcast: actually fire finalize → account[alice] += 20.
    // alice had 90 (after prior transfer_public). After this: 110.
    await token
      .withSigner(bob())
      .transfer_private_to_public.accepted({ sender: bobToken, receiver: alice(), amount: 20n });
    expect(await token.getAccount(alice())).toBe(110n);
  });

  it("transfer_public_to_private emits a private Token + decrements account[caller]", async () => {
    // alice has 110. Transfer 40 to bob (privately).
    const confirmed = await token
      .withSigner(alice())
      .transfer_public_to_private.accepted({ receiver: bob(), amount: 40n });
    const ciphertext = confirmed.rawOutputs[0]!;

    expect(ciphertext).toMatch(/^record1/);

    const recvToken = await decryptToken(ciphertext, bob());
    expect(recvToken.owner).toBe(bob().address);
    expect(recvToken.amount).toBe(40n);

    expect(await token.getAccount(alice())).toBe(70n);
  });
});
