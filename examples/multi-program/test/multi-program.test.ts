import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
} from "@lionden/testing";
import { createTreasury } from "../typechain/Treasury.js";
import { createRewards } from "../typechain/Rewards.js";

async function deployRewards() {
  const ctx = await setup();

  // Deploying "rewards" automatically deploys its transitive program
  // dependency "treasury" first (topological ordering). The library
  // "math_utils" is compiled but not deployed — libraries are compile-only.
  try {
    await ctx.deploy("rewards", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployRewards);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("treasury program", () => {
  const treasury = createTreasury();
  const signer = () => ctx!.accounts[0]!;

  beforeAll(() => {
    treasury.connect(ctx!.lre);
  });

  it("deposits funds for the signer", async () => {
    await treasury.deposit.accepted({ amount: 500n });

    expect(await treasury.mappings.deposits.get(signer())).toBe(500n);
  });

  it("accumulates multiple deposits", async () => {
    await treasury.deposit.accepted({ amount: 300n });

    // 500 from previous test + 300
    expect(await treasury.mappings.deposits.get(signer())).toBe(800n);
  });

  it("withdraws funds for the signer", async () => {
    await treasury.withdraw.accepted({ amount: 200n });

    // 800 - 200
    expect(await treasury.mappings.deposits.get(signer())).toBe(600n);
  });
});

describe("rewards program", () => {
  const treasury = createTreasury();
  const rewards = createRewards();
  const signer = () => ctx!.accounts[0]!;

  beforeAll(() => {
    treasury.connect(ctx!.lre);
    rewards.connect(ctx!.lre);
  });

  it("earns reward points", async () => {
    await rewards.earn_points.accepted({ amount: 75n });

    expect(await rewards.mappings.points.get(signer())).toBe(75n);
  });

  it("accumulates points across calls", async () => {
    await rewards.earn_points.accepted({ amount: 50n });

    // 75 + 50 = 125
    expect(await rewards.mappings.points.get(signer())).toBe(125n);
  });

  it("starts with no claimed status", async () => {
    expect(await rewards.mappings.claimed.tryGet(signer())).toBeNull();
  });

  describe("claim_reward (cross-program call)", () => {
    it("claims reward and deposits into treasury", async () => {
      // Signer has 125 points (>= 100 threshold), so claiming should succeed.
      // claim_reward calls treasury.aleo::deposit() cross-program.
      // Both programs use self.signer, so the deposit is keyed by account-0.
      await rewards.claim_reward.accepted({ reward_amount: 1000n });

      // Verify claimed flag is set
      expect(await rewards.mappings.claimed.get(signer())).toBe(true);

      // Verify the cross-program deposit landed in treasury under the signer.
      // Prior treasury balance was 600 (from deposit/withdraw tests) + 1000 reward.
      expect(await treasury.mappings.deposits.get(signer())).toBe(1600n);
    });
  });
});
