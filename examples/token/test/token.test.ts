import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
  assertMappingValue,
} from "@lionden/testing";
import { createToken } from "../typechain/index.js";

const RECEIVERS = {
  publicMint: "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5",
  publicTransfer: "aleo1gnkqe9m4f5wdl3q904xsf6ed9kavj0e6fnggtwyt8v8apw05gy9syz34cz",
  privateMint: "aleo1q25acjdgqgvkeyxdhfm2jx00yt5m0eztsjesx7f063l7q975559qvdtjw7",
} as const;

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

describe("token program", () => {
  describe("mint_public", () => {
    it("mints tokens to a receiver", async () => {
      const receiver = RECEIVERS.publicMint;
      await ctx!.execute("token.aleo", "mint_public", [receiver, "1000u64"]);

      await assertMappingValue(
        ctx!.connection,
        "token.aleo",
        "balances",
        receiver,
        "1000u64",
      );
    });
  });

  describe("transfer_public", () => {
    it("transfers from a different signer via options.signer", async () => {
      const account1 = ctx!.accounts[1]!;
      const receiver = RECEIVERS.publicTransfer;

      // Mint tokens to account-1 (using default signer account-0)
      await ctx!.execute("token.aleo", "mint_public", [account1.address, "5000u64"]);

      // transfer_public reads self.signer (token.aleo:24) to determine sender.
      // Using options.signer switches the signer to account-1.
      // If signer switching is broken, account-0 would be the sender and the
      // finalize assert(sender_balance >= amount) would fail or debit the
      // wrong account.
      await ctx!.execute("token.aleo", "transfer_public", [receiver, "2000u64"], {
        signer: account1,
      });

      // Verify account-1's balance decreased (5000 - 2000 = 3000)
      await assertMappingValue(
        ctx!.connection,
        "token.aleo",
        "balances",
        account1.address,
        "3000u64",
      );

      // Verify receiver got tokens
      await assertMappingValue(
        ctx!.connection,
        "token.aleo",
        "balances",
        receiver,
        "2000u64",
      );
    });
  });

  describe("withSigner (generated wrapper)", () => {
    it("transfers via contract.withSigner() using generated bindings", async () => {
      const account1 = ctx!.accounts[1]!;
      const account2 = ctx!.accounts[2]!;

      // Use the generated Token wrapper with withSigner()
      const token = createToken().connect(ctx!.lre);

      // Capture balances before to make assertions delta-based and order-independent
      const balance1Before = await token.getBalances(account1.address) ?? 0n;
      const balance2Before = await token.getBalances(account2.address) ?? 0n;

      // Mint tokens to account-1 so this test is self-contained
      await token.mint_publicBroadcast(account1.address, 5000n);

      // transfer_public reads self.signer (token.aleo:24) to determine sender.
      // If signer switching is broken, account-0 would be the sender and the
      // finalize assert(sender_balance >= amount) would fail or debit the
      // wrong account.
      const tokenAsAccount1 = token.withSigner(account1);
      await tokenAsAccount1.transfer_publicBroadcast(account2.address, 2000n);

      // Assert account-1's balance: +5000 (mint) -2000 (transfer) = +3000 delta
      const balance1 = await token.getBalances(account1.address);
      expect(balance1).toBe(balance1Before + 3000n);

      // Assert account-2's balance: +2000 delta
      const balance2 = await token.getBalances(account2.address);
      expect(balance2).toBe(balance2Before + 2000n);
    });
  });

  describe("mint_private", () => {
    it("returns a token record", async () => {
      const receiver = RECEIVERS.privateMint;
      const result = await ctx!.execute("token.aleo", "mint_private", [
        receiver,
        "500u64",
      ], { mode: "local" });

      expect(result.outputs).toHaveLength(1);
    });
  });

  describe("advanceBlocks", () => {
    it("advances blocks on the devnode", async () => {
      const heightBefore = await ctx!.connection.getBlockHeight();
      await ctx!.advanceBlocks(3);
      const heightAfter = await ctx!.connection.getBlockHeight();

      expect(heightAfter).toBeGreaterThanOrEqual(heightBefore + 3);
    });
  });
});
