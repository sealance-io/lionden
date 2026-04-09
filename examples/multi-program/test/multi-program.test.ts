import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  type TestContext,
  assertMappingValue,
  assertMappingEmpty,
} from "@lionden/testing";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();

  // Deploying "rewards" automatically deploys its transitive program
  // dependency "treasury" first (topological ordering). The library
  // "math_utils" is compiled but not deployed — libraries are compile-only.
  await ctx.deploy("rewards");
});

afterAll(async () => {
  await ctx.teardown();
});

describe("treasury program", () => {
  const signer = () => ctx.accounts[0]!.address;

  it("deposits funds for the signer", async () => {
    await ctx.execute("treasury.aleo", "deposit", ["500u64"]);

    await assertMappingValue(
      ctx.connection,
      "treasury.aleo",
      "deposits",
      signer(),
      "500u64",
    );
  });

  it("accumulates multiple deposits", async () => {
    await ctx.execute("treasury.aleo", "deposit", ["300u64"]);

    // 500 from previous test + 300
    await assertMappingValue(
      ctx.connection,
      "treasury.aleo",
      "deposits",
      signer(),
      "800u64",
    );
  });

  it("withdraws funds for the signer", async () => {
    await ctx.execute("treasury.aleo", "withdraw", ["200u64"]);

    // 800 - 200
    await assertMappingValue(
      ctx.connection,
      "treasury.aleo",
      "deposits",
      signer(),
      "600u64",
    );
  });
});

describe("rewards program", () => {
  const signer = () => ctx.accounts[0]!.address;

  it("earns reward points", async () => {
    await ctx.execute("rewards.aleo", "earn_points", ["75u64"]);

    await assertMappingValue(
      ctx.connection,
      "rewards.aleo",
      "points",
      signer(),
      "75u64",
    );
  });

  it("accumulates points across calls", async () => {
    await ctx.execute("rewards.aleo", "earn_points", ["50u64"]);

    // 75 + 50 = 125
    await assertMappingValue(
      ctx.connection,
      "rewards.aleo",
      "points",
      signer(),
      "125u64",
    );
  });

  it("starts with no claimed status", async () => {
    await assertMappingEmpty(
      ctx.connection,
      "rewards.aleo",
      "claimed",
      signer(),
    );
  });

  describe("claim_reward (cross-program call)", () => {
    it("claims reward and deposits into treasury", async () => {
      // Signer has 125 points (>= 100 threshold), so claiming should succeed.
      // claim_reward calls treasury.aleo::deposit() cross-program.
      // Both programs use self.signer, so the deposit is keyed by account-0.
      await ctx.execute("rewards.aleo", "claim_reward", ["1000u64"]);

      // Verify claimed flag is set
      await assertMappingValue(
        ctx.connection,
        "rewards.aleo",
        "claimed",
        signer(),
        "true",
      );

      // Verify the cross-program deposit landed in treasury under the signer.
      // Prior treasury balance was 600 (from deposit/withdraw tests) + 1000 reward.
      await assertMappingValue(
        ctx.connection,
        "treasury.aleo",
        "deposits",
        signer(),
        "1600u64",
      );
    });
  });
});
