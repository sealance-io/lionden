import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
} from "@lionden/testing";
import { createTokenContract, Leo } from "../typechain/index.js";
import { setupToken } from "../recipes/setup.js";

const RECEIVERS = {
  publicTransfer: "aleo1gnkqe9m4f5wdl3q904xsf6ed9kavj0e6fnggtwyt8v8apw05gy9syz34cz",
} as const;

async function deployToken() {
  const ctx = await setup();
  try {
    await setupToken(ctx);
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
  const token = createTokenContract();

  beforeAll(() => {
    token.connect(ctx!.lre);
  });

  describe("mint_public", () => {
    it("recipe minted initial supply to treasury", async () => {
      const treasury = ctx!.named.address("treasury");
      expect(await token.getBalances(treasury)).toBe(1_000_000n);
    });
  });

  describe("transfer_public", () => {
    it("transfers via withSigner using generated bindings", async () => {
      const account1 = ctx!.accounts[1]!;
      const account2 = ctx!.accounts[2]!;

      // Capture balances before to keep assertions delta-based and order-independent.
      const balance1Before = (await token.getBalances(account1)) ?? 0n;
      const balance2Before = (await token.getBalances(account2)) ?? 0n;

      // Mint tokens to account-1 (default signer is account-0)
      await token.mint_public.accepted({ receiver: account1, amount: 5000n });

      // transfer_public reads self.signer (token.aleo:24) to determine sender.
      // withSigner switches the signer to account-1; if signer switching is
      // broken, account-0 would be the sender and the finalize
      // assert(sender_balance >= amount) would fail or debit the wrong account.
      await token.withSigner(account1).transfer_public.accepted({ receiver: account2, amount: 2000n });

      // account-1: +5000 (mint) -2000 (transfer) = +3000 delta
      expect(await token.getBalances(account1)).toBe(balance1Before + 3000n);

      // account-2: +2000 delta
      expect(await token.getBalances(account2)).toBe(balance2Before + 2000n);
    });

    it("supports per-call signer override via options.signer", async () => {
      const account1 = ctx!.accounts[1]!;
      const receiver = Leo.address(RECEIVERS.publicTransfer);

      const balance1Before = (await token.getBalances(account1)) ?? 0n;
      const receiverBefore = (await token.getBalances(receiver)) ?? 0n;

      // Mint to account-1 (default signer)
      await token.mint_public.accepted({ receiver: account1, amount: 5000n });

      // Per-call signer override (alternate to withSigner)
      await token.transfer_public.accepted({ receiver, amount: 2000n }, { signer: account1 });

      expect(await token.getBalances(account1)).toBe(balance1Before + 3000n);
      expect(await token.getBalances(receiver)).toBe(receiverBefore + 2000n);
    });
  });

  describe("mint_private", () => {
    it("decrypts a private Token record from typed accepted outputs", async () => {
      const receiver = ctx!.accounts[1]!;
      const confirmed = await token.mint_private.accepted({ receiver, amount: 500n });

      expect(confirmed.outputs.ciphertext).toMatch(/^record1/);
      expect(confirmed.rawOutputs[0]).toBe(confirmed.outputs.ciphertext);

      const record = await confirmed.outputs.decrypt(receiver);

      expect(record.owner).toBe(receiver.address);
      expect(record.amount).toBe(500n);
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

  describe("named accounts", () => {
    it("deployer resolves to a signable devnode account", () => {
      const deployer = ctx!.named.signer("deployer");
      // default: 0 in config → DEVNODE_ACCOUNTS[0]
      expect(deployer.address).toMatch(/^aleo1/);
    });

    it("treasury resolves to an address-only account and can be used as a recipient", async () => {
      const treasury = ctx!.named.address("treasury");
      expect(treasury.type).toBe("address-only");

      const balanceBefore = (await token.getBalances(treasury)) ?? 0n;

      // Mint to treasury using its named address rather than a hardcoded string
      await token.mint_public.accepted({ receiver: treasury, amount: 100n });

      expect(await token.getBalances(treasury)).toBe(balanceBefore + 100n);
    });
  });
});
