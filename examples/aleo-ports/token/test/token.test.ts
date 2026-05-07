// Port of tmp/leo-examples/token/. Two-actor demo (alice, bob) exercising
// the four mint/transfer combinations: mint_public, mint_private,
// transfer_public, transfer_private, transfer_public_to_private,
// transfer_private_to_public.
//
// Patterns used here:
//   - Pure transitions (mint_private, transfer_private) → local mode only.
//   - Final-only (mint_public, transfer_public) → onchain default; assert
//     mapping after.
//   - Mixed (transfer_private_to_public, transfer_public_to_private) →
//     two calls (local for record output, onchain for finalize).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  assertMappingValue,
  type TestContext,
} from "@lionden/testing";

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

function extractAmount(record: string): string {
  const match = record.match(/amount:\s*(\d+u64)/);
  if (!match) throw new Error(`could not extract amount from: ${record}`);
  return match[1]!;
}

describe("token.aleo", () => {
  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  it("mint_public increments account[receiver]", async () => {
    await ctx!.execute(
      "token.aleo",
      "mint_public",
      [alice().address, "100u64"],
      { signer: alice() },
    );
    await assertMappingValue(ctx!.connection, "token.aleo", "account", alice().address, "100u64");
  });

  it("mint_private returns a Token record (no mapping side effect)", async () => {
    const result = await ctx!.execute(
      "token.aleo",
      "mint_private",
      [bob().address, "100u64"],
      { mode: "local", signer: bob() },
    );
    const token = result.outputs[0]!;
    expect(token).toContain(bob().address);
    expect(extractAmount(token)).toBe("100u64");
  });

  it("transfer_public moves balance between accounts", async () => {
    // alice has 100 from earlier mint_public. Send 10 to bob.
    await ctx!.execute(
      "token.aleo",
      "transfer_public",
      [bob().address, "10u64"],
      { signer: alice() },
    );
    await assertMappingValue(ctx!.connection, "token.aleo", "account", alice().address, "90u64");
    await assertMappingValue(ctx!.connection, "token.aleo", "account", bob().address, "10u64");
  });

  it("transfer_private splits a Token into (remainder, transferred)", async () => {
    // Mint a fresh private token to bob in local mode.
    const minted = await ctx!.execute(
      "token.aleo",
      "mint_private",
      [bob().address, "100u64"],
      { mode: "local", signer: bob() },
    );
    const bobToken = minted.outputs[0]!;

    // Bob splits 30 to alice.
    const result = await ctx!.execute(
      "token.aleo",
      "transfer_private",
      [bobToken, alice().address, "30u64"],
      { mode: "local", signer: bob() },
    );
    expect(result.outputs).toHaveLength(2);
    const remaining = result.outputs[0]!;
    const transferred = result.outputs[1]!;

    expect(remaining).toContain(bob().address);
    expect(extractAmount(remaining)).toBe("70u64");
    expect(transferred).toContain(alice().address);
    expect(extractAmount(transferred)).toBe("30u64");
  });

  it("transfer_private_to_public yields a remainder Token + bumps account[receiver]", async () => {
    // Mint a fresh 50-token to bob (private) — mint_private is pure, ok in local.
    const minted = await ctx!.execute(
      "token.aleo",
      "mint_private",
      [bob().address, "50u64"],
      { mode: "local", signer: bob() },
    );
    const bobToken = minted.outputs[0]!;

    // Local: capture remainder Token plaintext.
    const local = await ctx!.execute(
      "token.aleo",
      "transfer_private_to_public",
      [bobToken, alice().address, "20u64"],
      { mode: "local", signer: bob() },
    );
    expect(extractAmount(local.outputs[0]!)).toBe("30u64");

    // Onchain: actually fire finalize → account[alice] += 20.
    // alice had 90 (after prior transfer_public). After this: 110.
    await ctx!.execute(
      "token.aleo",
      "transfer_private_to_public",
      [bobToken, alice().address, "20u64"],
      { signer: bob() },
    );
    await assertMappingValue(ctx!.connection, "token.aleo", "account", alice().address, "110u64");
  });

  it("transfer_public_to_private emits a private Token + decrements account[caller]", async () => {
    // alice has 110. Transfer 40 to bob (privately).
    const local = await ctx!.execute(
      "token.aleo",
      "transfer_public_to_private",
      [bob().address, "40u64"],
      { mode: "local", signer: alice() },
    );
    const recvToken = local.outputs[0]!;
    expect(recvToken).toContain(bob().address);
    expect(extractAmount(recvToken)).toBe("40u64");

    await ctx!.execute(
      "token.aleo",
      "transfer_public_to_private",
      [bob().address, "40u64"],
      { signer: alice() },
    );
    await assertMappingValue(ctx!.connection, "token.aleo", "account", alice().address, "70u64");
  });
});
