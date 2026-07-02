// Port of tmp/leo-examples/dynamic_dispatch/ (upstream PR #31, branch
// mohammadfawaz/dynamic_dispatch @ 0dce7ca). Three programs exercise Leo
// v4's interface declarations and runtime dynamic dispatch:
//
//   voting_power.aleo : VotingStrategy   — linear: power = balance
//   quadratic_power.aleo : VotingStrategy — quadratic: power = floor(√balance)
//   governance.aleo                       — dispatch hub, calls
//                                           VotingStrategy@(strategy)::compute_power(...)
//
// Direct-strategy calls run in mode: "local" — pure compute.
// Dispatch-through-governance is covered in both local mode, proving
// `execution.imports["governance.aleo"]` is threaded into pm.run, and
// onchain via accepted(), making confirmation status explicit.
//
// Identifier-arg encoding: Leo's wire format for an `identifier` is
// `'name'` (literal single quotes). Leo.identifier("voting_power") gives
// the typed wrapper a safe value to serialize for the wire.
// Source: upstream dynamic_dispatch/run.sh:79 and
// packages/leo-compiler/src/codegen/__goldens__/base-contract.ts.

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Leo } from "../typechain/BaseContract.js";
import { createGovernance } from "../typechain/Governance.js";
import { createQuadraticPower } from "../typechain/QuadraticPower.js";
import { createVotingPower } from "../typechain/VotingPower.js";

async function deployDispatch() {
  const ctx = await setup();
  try {
    // Runtime dispatch targets are declared in lionden.config.ts under
    // `execution.imports["governance.aleo"]`, not as static `import`
    // statements in governance/main.leo. That config makes the SDK load
    // the strategy programs at execute time but does NOT make them
    // deploy-time deps — the dependency resolver only follows static
    // imports — so each strategy program is deployed explicitly here
    // before the dispatch hub.
    await ctx.deploy("voting_power", { noCompile: true });
    await ctx.deploy("quadratic_power", { noCompile: true });
    await ctx.deploy("governance", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployDispatch);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("dynamic_dispatch — direct strategy parity (local)", () => {
  const linear = createVotingPower();
  const quadratic = createQuadraticPower();

  beforeAll(() => {
    linear.connect(ctx!.lre);
    quadratic.connect(ctx!.lre);
  });

  // Mirrors run.sh stage 1 — pure compute, no dispatch.
  it("voting_power.compute_power(10000) = 10000", async () => {
    expect(await linear.compute_power.locally(10000n)).toBe(10000n);
  });

  it("voting_power.compute_power(100) = 100", async () => {
    expect(await linear.compute_power.locally(100n)).toBe(100n);
  });

  it("quadratic_power.compute_power(10000) = 100 (√10000)", async () => {
    expect(await quadratic.compute_power.locally(10000n)).toBe(100n);
  });

  it("quadratic_power.compute_power(100) = 10 (√100)", async () => {
    expect(await quadratic.compute_power.locally(100n)).toBe(10n);
  });
});

describe("dynamic_dispatch — runtime dispatch through governance (local)", () => {
  const governance = createGovernance();

  beforeAll(() => {
    governance.connect(ctx!.lre);
  });

  it("get_voting_power('voting_power', 10000) resolves through config execution.imports", async () => {
    await expect(
      governance.get_voting_power.locally(Leo.identifier("voting_power"), 10000n),
    ).resolves.toBe(10000n);
  });
});

describe("dynamic_dispatch — runtime dispatch through governance (onchain)", () => {
  const governance = createGovernance();

  beforeAll(() => {
    governance.connect(ctx!.lre);
  });

  // The signer for tests is devnode account-0 — its view key decrypts the
  // private plaintext outputs returned by governance's transitions.
  const signer = () => ctx!.accounts[0]!.privateKey;

  it("get_voting_power('voting_power', 10000) → status accepted, no decrypt", async () => {
    const result = await governance.get_voting_power.accepted(
      Leo.identifier("voting_power"),
      10000n,
    );
    expect(result.txId).toBeTruthy();
    expect(result.status).toBe("accepted");
    // EncryptedValue<bigint> handle present; decrypt skipped on this case.
    expect(result.outputs.ciphertext).toMatch(/^ciphertext1/);
  });

  it("get_voting_power('voting_power', 42) → outputs.decrypt yields 42n (linear)", async () => {
    const result = await governance.get_voting_power.accepted(Leo.identifier("voting_power"), 42n);
    expect(await result.outputs.decrypt(signer())).toBe(42n);
  });

  it("get_voting_power('quadratic_power', 10000) → outputs.decrypt yields 100n (√10000)", async () => {
    const result = await governance.get_voting_power.accepted(
      Leo.identifier("quadratic_power"),
      10000n,
    );
    expect(await result.outputs.decrypt(signer())).toBe(100n);
  });

  // proposal_passes uses monotonic strategies: for_balance > against_balance
  // implies for_power >= against_power, so both strategies vote the same
  // direction (the whale wins). Upstream run.sh frames this as a *margin*
  // demo. The typed `outputs` carries an EncryptedValue<boolean> handle.
  it("proposal_passes('voting_power', 1000000, 10000) → outputs.decrypt yields true (whale wins linear)", async () => {
    const result = await governance.proposal_passes.accepted(
      Leo.identifier("voting_power"),
      1000000n,
      10000n,
    );
    expect(await result.outputs.decrypt(signer())).toBe(true);
  });

  it("proposal_passes('quadratic_power', 1000000, 10000) → outputs.decrypt yields true (whale still wins, smaller margin)", async () => {
    const result = await governance.proposal_passes.accepted(
      Leo.identifier("quadratic_power"),
      1000000n,
      10000n,
    );
    expect(await result.outputs.decrypt(signer())).toBe(true);
  });

  it("compare_strategies(10000) → tuple outputs decrypt to [10000n (linear), 100n (quadratic)]", async () => {
    const result = await governance.compare_strategies.accepted(10000n);
    const [linear, quadratic] = result.outputs;
    expect(await linear.decrypt(signer())).toBe(10000n);
    expect(await quadratic.decrypt(signer())).toBe(100n);
  });
});
