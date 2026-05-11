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
// Dispatch-through-governance calls run onchain via accepted(), making
// confirmation status explicit. The investigative .skip'd block
// at the bottom is a runnable probe for whether local mode resolves
// dispatch through static imports — un-skip locally to populate the
// journey-doc insight.
//
// Identifier-arg encoding: Leo's wire format for an `identifier` is
// `'name'` (literal single quotes). Leo.identifier("voting_power") gives
// the typed wrapper a safe value to serialize for the wire.
// Source: upstream dynamic_dispatch/run.sh:79 and
// packages/leo-compiler/src/codegen/__goldens__/base-contract.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createGovernance } from "../typechain/Governance.js";
import { createVotingPower } from "../typechain/VotingPower.js";
import { createQuadraticPower } from "../typechain/QuadraticPower.js";
import { Leo } from "../typechain/BaseContract.js";

async function deployDispatch() {
  const ctx = await setup();
  try {
    // Deploying governance transitively deploys voting_power and
    // quadratic_power in topological order (per packages/leo-compiler
    // dependency-resolver). The two implementer programs are listed as
    // explicit `import` statements in governance/main.leo even though
    // dispatch is via interface — lionden's source-first layout has no
    // program.json, and the dependency-resolver only follows static
    // imports.
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
    expect(await linear.compute_power.locally({ balance: 10000n })).toBe(10000n);
  });

  it("voting_power.compute_power(100) = 100", async () => {
    expect(await linear.compute_power.locally({ balance: 100n })).toBe(100n);
  });

  it("quadratic_power.compute_power(10000) = 100 (√10000)", async () => {
    expect(await quadratic.compute_power.locally({ balance: 10000n })).toBe(100n);
  });

  it("quadratic_power.compute_power(100) = 10 (√100)", async () => {
    expect(await quadratic.compute_power.locally({ balance: 100n })).toBe(10n);
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
    const result = await governance.get_voting_power.accepted({
      strategy: Leo.identifier("voting_power"),
      balance: 10000n,
    });
    expect(result.txId).toBeTruthy();
    expect(result.status).toBe("accepted");
    // EncryptedValue<bigint> handle present; decrypt skipped on this case.
    expect(result.outputs.ciphertext).toMatch(/^ciphertext1/);
  });

  it("get_voting_power('voting_power', 42) → outputs.decrypt yields 42n (linear)", async () => {
    const result = await governance.get_voting_power.accepted({
      strategy: Leo.identifier("voting_power"),
      balance: 42n,
    });
    expect(await result.outputs.decrypt(signer())).toBe(42n);
  });

  it("get_voting_power('quadratic_power', 10000) → outputs.decrypt yields 100n (√10000)", async () => {
    const result = await governance.get_voting_power.accepted({
      strategy: Leo.identifier("quadratic_power"),
      balance: 10000n,
    });
    expect(await result.outputs.decrypt(signer())).toBe(100n);
  });

  // proposal_passes uses monotonic strategies: for_balance > against_balance
  // implies for_power >= against_power, so both strategies vote the same
  // direction (the whale wins). Upstream run.sh frames this as a *margin*
  // demo. The typed `outputs` carries an EncryptedValue<boolean> handle.
  it("proposal_passes('voting_power', 1000000, 10000) → outputs.decrypt yields true (whale wins linear)", async () => {
    const result = await governance.proposal_passes.accepted({
      strategy: Leo.identifier("voting_power"),
      for_balance: 1000000n,
      against_balance: 10000n,
    });
    expect(await result.outputs.decrypt(signer())).toBe(true);
  });

  it("proposal_passes('quadratic_power', 1000000, 10000) → outputs.decrypt yields true (whale still wins, smaller margin)", async () => {
    const result = await governance.proposal_passes.accepted({
      strategy: Leo.identifier("quadratic_power"),
      for_balance: 1000000n,
      against_balance: 10000n,
    });
    expect(await result.outputs.decrypt(signer())).toBe(true);
  });

  it("compare_strategies(10000) → tuple outputs decrypt to [10000n (linear), 100n (quadratic)]", async () => {
    const result = await governance.compare_strategies.accepted({ balance: 10000n });
    const [linear, quadratic] = result.outputs;
    expect(await linear.decrypt(signer())).toBe(10000n);
    expect(await quadratic.decrypt(signer())).toBe(100n);
  });
});

// Investigative spike — NOT a parity assertion. Un-skip locally to learn
// whether `pm.run` (local mode) resolves runtime dynamic dispatch through
// the static import list. Outcome lands as a journey-doc insight, not a
// regression check.
describe.skip("[spike] governance dispatch in local mode (informational only)", () => {
  it("local-mode get_voting_power resolves through static imports?", async () => {
    const governance = createGovernance().connect(ctx!.lre);
    const result = await governance.get_voting_power.locally({
      strategy: Leo.identifier("voting_power"),
      balance: 10000n,
    });
    expect(result).toBeDefined();
  });
});
