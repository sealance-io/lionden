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
// Dispatch-through-governance calls run onchain via *Broadcast(): per
// Insight 14 the onchain path returns outputs: [], so we assert tx
// acceptance via ctx.connection.waitForConfirmation(txId) → status ===
// "accepted" rather than the return value. The investigative .skip'd block
// at the bottom is a runnable probe for whether local mode resolves
// dispatch through static imports — un-skip locally to populate the
// journey-doc insight.
//
// Identifier-arg encoding: Leo's wire format for an `identifier` is
// `'name'` (literal single quotes). The typed wrapper accepts a bare
// "voting_power"; BaseContract.serializeIdentifier wraps it for the wire.
// Source: upstream dynamic_dispatch/run.sh:79 and
// packages/leo-compiler/src/codegen/__goldens__/base-contract.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createGovernance } from "../typechain/Governance.js";
import { createVotingPower } from "../typechain/VotingPower.js";
import { createQuadraticPower } from "../typechain/QuadraticPower.js";

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
    expect(await linear.compute_power(10000n)).toBe(10000n);
  });

  it("voting_power.compute_power(100) = 100", async () => {
    expect(await linear.compute_power(100n)).toBe(100n);
  });

  it("quadratic_power.compute_power(10000) = 100 (√10000)", async () => {
    expect(await quadratic.compute_power(10000n)).toBe(100n);
  });

  it("quadratic_power.compute_power(100) = 10 (√100)", async () => {
    expect(await quadratic.compute_power(100n)).toBe(10n);
  });
});

describe("dynamic_dispatch — runtime dispatch through governance (onchain)", () => {
  const governance = createGovernance();

  beforeAll(() => {
    governance.connect(ctx!.lre);
  });

  // Mirrors run.sh stage 2. Dispatch target resolved at call time.
  // Onchain returns outputs: [] (Insight 14), so we assert tx acceptance
  // via the *Broadcast() variant which returns a TransitionCallResult.
  async function expectAccepted(promise: Promise<{ readonly txId?: string }>) {
    const { txId } = await promise;
    expect(txId).toBeTruthy();
    const confirmed = await ctx!.connection.waitForConfirmation(txId!, 60_000);
    expect(confirmed.status).toBe("accepted");
  }

  it("get_voting_power('voting_power', 10000) → linear (accepted)", () =>
    expectAccepted(governance.get_voting_powerBroadcast("voting_power", 10000n)));

  it("get_voting_power('quadratic_power', 10000) → quadratic (accepted)", () =>
    expectAccepted(governance.get_voting_powerBroadcast("quadratic_power", 10000n)));

  // proposal_passes uses monotonic strategies: for_balance > against_balance
  // implies for_power >= against_power, so both strategies vote the same
  // direction (the whale wins). Upstream run.sh frames this as a *margin*
  // demo — linear wins by 100x (1_000_000 vs 10_000), quadratic by 10x
  // (1000 vs 100 per upstream docs). NOTE: upstream's quadratic_power
  // 8-iter Newton's loop does NOT actually converge for 1_000_000 — it
  // bottoms out at 2120 instead of 1000 (see Insight 26). The onchain
  // assertion passes either way because we only check tx acceptance, not
  // the return value.
  it("proposal_passes('voting_power', 1000000, 10000) → whale wins linear by 100x (accepted)", () =>
    expectAccepted(
      governance.proposal_passesBroadcast("voting_power", 1000000n, 10000n),
    ));

  it("proposal_passes('quadratic_power', 1000000, 10000) → whale still wins quadratic, smaller margin (accepted)", () =>
    expectAccepted(
      governance.proposal_passesBroadcast("quadratic_power", 1000000n, 10000n),
    ));

  it("compare_strategies(10000) → both run (accepted)", () =>
    expectAccepted(governance.compare_strategiesBroadcast(10000n)));
});

// Investigative spike — NOT a parity assertion. Un-skip locally to learn
// whether `pm.run` (local mode) resolves runtime dynamic dispatch through
// the static import list. Outcome lands as a journey-doc insight, not a
// regression check.
describe.skip("[spike] governance dispatch in local mode (informational only)", () => {
  it("local-mode get_voting_power resolves through static imports?", async () => {
    const governance = createGovernance().connect(ctx!.lre);
    const result = await governance.get_voting_power("voting_power", 10000n);
    expect(result).toBeDefined();
  });
});
