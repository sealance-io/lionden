// Port of tmp/leo-examples/dynamic_records/ (branch
// mohammadfawaz/dynamic_records @ b208247c). This is the aleo-port that
// combines Leo v4 runtime dispatch with `dyn record` inputs and outputs.
//
// Runtime imports are supplied through the generated wrappers here:
//   - the main router instance carries instance-level imports
//   - one focused test passes the same imports as per-call options
//
// The direct token wrappers keep concrete Token records typed; asGoldToken()
// and asSilverToken() convert those records to typed dynamic-record inputs.
// Current confirmed transactions expose `dyn record` outputs as id-only
// `record_dynamic` outputs. These assertions intentionally track that node
// shape; concrete token outputs are still used when a spendable/decryptable
// record is needed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
} from "@lionden/testing";
import { Leo } from "../typechain/BaseContract.js";
import { asGoldToken, createGoldToken } from "../typechain/GoldToken.js";
import { asSilverToken, createSilverToken } from "../typechain/SilverToken.js";
import { createTokenRouter } from "../typechain/TokenRouter.js";

const RUNTIME_IMPORTS = ["gold_token.aleo", "silver_token.aleo"] as const;

async function deployDynamicRecords() {
  const ctx = await setup();
  try {
    await ctx.deploy("gold_token", { noCompile: true });
    await ctx.deploy("silver_token", { noCompile: true });
    await ctx.deploy("token_router", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployDynamicRecords);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) {
    await ctx.teardown();
  } else {
    clearFixtures();
  }
});

describe("dynamic_records direct token parity", () => {
  const gold = createGoldToken();
  const silver = createSilverToken();
  const owner = () => ctx!.accounts[0]!;

  beforeAll(() => {
    gold.connect(ctx!.lre);
    silver.connect(ctx!.lre);
  });

  it("gold_token.mint_custom.accepted returns owner, amount, and purity", async () => {
    const confirmed = await gold.mint_custom.accepted({
      owner: owner(),
      amount: 1000n,
      purity: 24n,
    });
    const token = await confirmed.outputs.decrypt(owner());

    expect(token.owner).toBe(owner().address);
    expect(token.amount).toBe(1000n);
    expect(token.purity).toBe(24n);
  });

  it("silver_token.mint_custom.accepted returns owner, amount, and grade", async () => {
    const confirmed = await silver.mint_custom.accepted({
      owner: owner(),
      amount: 2000n,
      grade: 3n,
    });
    const token = await confirmed.outputs.decrypt(owner());

    expect(token.owner).toBe(owner().address);
    expect(token.amount).toBe(2000n);
    expect(token.grade).toBe(3n);
  });
});

describe("dynamic_records runtime dispatch", () => {
  const gold = createGoldToken();
  const silver = createSilverToken();
  const router = createTokenRouter({ imports: RUNTIME_IMPORTS });
  const perCallRouter = createTokenRouter();

  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    gold.connect(ctx!.lre);
    silver.connect(ctx!.lre);
    router.connect(ctx!.lre);
    perCallRouter.connect(ctx!.lre);
  });

  async function expectAccepted(txId: string, transitionName: string) {
    const confirmed = await ctx!.connection.waitForConfirmation(txId);
    expect(confirmed.status).toBe("accepted");
    const transition = confirmed.transitions.find(
      (candidate) =>
        candidate.programId === "token_router.aleo" &&
        candidate.transitionName === transitionName,
    );
    expect(transition).toBeDefined();
    return transition!;
  }

  function expectIdOnlyDynamicRecord(rawOutputs: readonly unknown[]) {
    expect(rawOutputs).toHaveLength(1);
    expect(rawOutputs[0]).toMatchObject({
      kind: "idOnly",
      type: "record_dynamic",
      id: expect.any(String),
    });
  }

  it("demo_transfer routes gold through instance-level imports and confirms accepted", async () => {
    const submitted = await router.demo_transfer.submitted({
      token_program: Leo.identifier("gold_token"),
      owner: alice(),
      amount: 1000n,
      to: alice(),
    });

    const transition = await expectAccepted(submitted.txId, "demo_transfer");
    expectIdOnlyDynamicRecord(transition.rawOutputs);
  });

  it("demo_transfer routes silver through instance-level imports and confirms accepted", async () => {
    const submitted = await router.demo_transfer.submitted({
      token_program: Leo.identifier("silver_token"),
      owner: alice(),
      amount: 2000n,
      to: alice(),
    });

    const transition = await expectAccepted(submitted.txId, "demo_transfer");
    expectIdOnlyDynamicRecord(transition.rawOutputs);
  });

  it("typed dynamic-record helpers feed read_balance", async () => {
    const minted = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 777n,
      purity: 21n,
    });

    const result = await router.read_balance.accepted({
      token_program: Leo.identifier("gold_token"),
      token: asGoldToken(await minted.outputs.decrypt(alice())),
    });

    expect(await result.outputs.decrypt(alice())).toBe(777n);
  });

  it("typed dynamic-record helpers feed route_transfer and confirm accepted", async () => {
    const minted = await silver.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 1200n,
      grade: 2n,
    });

    const submitted = await router.route_transfer.submitted({
      token_program: Leo.identifier("silver_token"),
      token: asSilverToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });

    const transition = await expectAccepted(submitted.txId, "route_transfer");
    expectIdOnlyDynamicRecord(transition.rawOutputs);
  });

  it("typed dynamic-record helpers feed gold_beats_silver", async () => {
    const goldMint = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 900n,
      purity: 18n,
    });
    const silverMint = await silver.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 300n,
      grade: 3n,
    });

    const result = await router.gold_beats_silver.accepted({
      gold_tok: asGoldToken(await goldMint.outputs.decrypt(alice())),
      silver_tok: asSilverToken(await silverMint.outputs.decrypt(alice())),
    });

    expect(await result.outputs.decrypt(alice())).toBe(true);
  });

  it("per-call runtime imports feed has_more without router constructor imports", async () => {
    const goldMint = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 250n,
      purity: 22n,
    });
    const silverMint = await silver.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 400n,
      grade: 2n,
    });

    const result = await perCallRouter.has_more.accepted(
      {
        prog_a: Leo.identifier("gold_token"),
        tok_a: asGoldToken(await goldMint.outputs.decrypt(alice())),
        prog_b: Leo.identifier("silver_token"),
        tok_b: asSilverToken(await silverMint.outputs.decrypt(alice())),
      },
      { imports: RUNTIME_IMPORTS },
    );

    expect(await result.outputs.decrypt(alice())).toBe(false);
  });
});
