// Port of tmp/leo-examples/dynamic_records/ (branch
// mohammadfawaz/dynamic_records @ b208247c). Combines Leo v4 runtime dispatch
// with `dyn record` inputs and outputs, plus a `probe_records` program that
// exercises external `Record` outputs and nested-call-graph flows.
//
// Output-side typing (post-Phase-B/C):
//   - `dyn record` outputs surface as `IdOnlyDynamicRecordHandle` — inert by
//     design, no decrypt method (the chain exposes no ciphertext for
//     `record_dynamic` outputs, not even on the producing transition).
//   - External `Record` outputs surface as `IdOnlyExternalRecordHandle<T>` —
//     the ciphertext lives on the callee transition, so `.decryptFrom` takes
//     a selector (named `{ programId, transitionName, outputIndex }` or
//     positional `{ transitionIndex, outputIndex }`).
//   - Local concrete records (including from dyn-input transitions) keep
//     emitting `EncryptedRecord<T>` and decrypt the existing way.
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
import { createProbeRecords, GoldToken_Token } from "../typechain/ProbeRecords.js";

const RUNTIME_IMPORTS = ["gold_token.aleo", "silver_token.aleo"] as const;

async function deployDynamicRecords() {
  const ctx = await setup();
  try {
    await ctx.deploy("gold_token", { noCompile: true });
    await ctx.deploy("silver_token", { noCompile: true });
    await ctx.deploy("token_router", { noCompile: true });
    await ctx.deploy("probe_records", { noCompile: true });
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

  it("demo_transfer surfaces an IdOnlyDynamicRecordHandle for gold", async () => {
    const accepted = await router.demo_transfer.accepted({
      token_program: Leo.identifier("gold_token"),
      owner: alice(),
      amount: 1000n,
      to: alice(),
    });

    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");
    expect(accepted.outputs.type).toBe("record_dynamic");
    expect(accepted.outputs.id).toMatch(/^[0-9]+field$/);
    // Inspection on `.transitions` is allowed; no decryptFrom by design.
    expect(accepted.outputs.transitions.length).toBeGreaterThan(0);
  });

  it("demo_transfer surfaces an IdOnlyDynamicRecordHandle for silver", async () => {
    const accepted = await router.demo_transfer.accepted({
      token_program: Leo.identifier("silver_token"),
      owner: alice(),
      amount: 2000n,
      to: alice(),
    });

    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");
    expect(accepted.outputs.type).toBe("record_dynamic");
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

  it("route_transfer surfaces an IdOnlyDynamicRecordHandle for silver", async () => {
    const minted = await silver.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 1200n,
      grade: 2n,
    });

    const accepted = await router.route_transfer.accepted({
      token_program: Leo.identifier("silver_token"),
      token: asSilverToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });

    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");
    expect(accepted.outputs.type).toBe("record_dynamic");
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

describe("probe_records external + nested record outputs", () => {
  const gold = createGoldToken();
  const probe = createProbeRecords({ imports: ["gold_token.aleo", "silver_token.aleo"] });

  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    gold.connect(ctx!.lre);
    probe.connect(ctx!.lre);
  });

  it("wrap_mint_gold returns IdOnlyExternalRecordHandle<GoldToken_Token>; decryptFrom recovers the token from the callee transition (named selector)", async () => {
    const accepted = await probe.withSigner(alice()).wrap_mint_gold.accepted({
      to: bob(),
      amount: 100n,
    });

    expect(accepted.outputs.kind).toBe("idOnlyExternalRecord");
    expect(accepted.outputs.type).toBe("external_record");

    const token = await accepted.outputs.decryptFrom(
      GoldToken_Token.asOutput,
      bob(),
      { programId: "gold_token.aleo", transitionName: "mint", outputIndex: 0 },
    );

    expect(token.owner).toBe(bob().address);
    expect(token.amount).toBe(100n);
  });

  it("wrap_mint_gold also resolves via positional selector { transitionIndex, outputIndex }", async () => {
    const accepted = await probe.withSigner(alice()).wrap_mint_gold.accepted({
      to: bob(),
      amount: 50n,
    });

    // The callee transition (`gold_token.mint`) is the one that actually
    // holds the record ciphertext. Find its index in the callgraph.
    const calleeIndex = accepted.outputs.transitions.findIndex(
      (t) => t.programId === "gold_token.aleo" && t.transitionName === "mint",
    );
    expect(calleeIndex).toBeGreaterThanOrEqual(0);

    const token = await accepted.outputs.decryptFrom(
      GoldToken_Token.asOutput,
      bob(),
      { transitionIndex: calleeIndex, outputIndex: 0 },
    );
    expect(token.owner).toBe(bob().address);
    expect(token.amount).toBe(50n);
  });

  it("issue_receipt: concrete Receipt output is decryptable even though inputs are dyn record", async () => {
    const minted = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 500n,
      purity: 12n,
    });

    const accepted = await probe.withSigner(alice()).issue_receipt.accepted({
      token_program: Leo.identifier("gold_token"),
      token: asGoldToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });

    // Receipt is a local concrete record — decryptable via the existing
    // EncryptedRecord<T> path. The owner field is `bob` because the function
    // emits `Receipt { owner: to, balance }`.
    const receipt = await accepted.outputs.decrypt(bob());
    expect(receipt.owner).toBe(bob().address);
    expect(receipt.balance).toBe(500n);
  });

  it("dispatch_and_receipt: intermediate dyn-record dispatch does not poison the concrete final output", async () => {
    const minted = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 700n,
      purity: 9n,
    });

    const accepted = await probe.withSigner(alice()).dispatch_and_receipt.accepted({
      token_program: Leo.identifier("gold_token"),
      token: asGoldToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });

    // Final Receipt has a real ciphertext on probe_records' own transition,
    // even though the intermediate `gold_token.transfer` call returned a
    // dyn-record (id-only) value.
    const receipt = await accepted.outputs.decrypt(bob());
    expect(receipt.owner).toBe(bob().address);
    expect(receipt.balance).toBe(700n);
  });
});

describe("IdOnlyExternalRecordHandle.decryptFrom negative cases", () => {
  const probe = createProbeRecords({ imports: ["gold_token.aleo", "silver_token.aleo"] });
  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    probe.connect(ctx!.lre);
  });

  async function getHandle() {
    const accepted = await probe.withSigner(alice()).wrap_mint_gold.accepted({
      to: bob(),
      amount: 1n,
    });
    expect(accepted.outputs.kind).toBe("idOnlyExternalRecord");
    return accepted.outputs;
  }

  it("transition-not-found when the named transition isn't in the callgraph", async () => {
    const handle = await getHandle();
    await expect(
      handle.decryptFrom(GoldToken_Token.asOutput, bob(), {
        programId: "missing.aleo",
        transitionName: "nope",
        outputIndex: 0,
      }),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "transition-not-found",
    });
  });

  it("transition-index-out-of-range for positional selectors past the callgraph", async () => {
    const handle = await getHandle();
    await expect(
      handle.decryptFrom(GoldToken_Token.asOutput, bob(), {
        transitionIndex: 999,
        outputIndex: 0,
      }),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "transition-index-out-of-range",
    });
  });

  it("program-mismatch when projector points at a different program than the selected transition", async () => {
    const handle = await getHandle();
    // Find the caller's own transition (probe_records.aleo) — passing the
    // gold_token projector against the probe_records transition should
    // produce a program-mismatch.
    const callerIndex = handle.transitions.findIndex(
      (t) => t.programId === "probe_records.aleo" && t.transitionName === "wrap_mint_gold",
    );
    expect(callerIndex).toBeGreaterThanOrEqual(0);

    await expect(
      handle.decryptFrom(GoldToken_Token.asOutput, bob(), {
        transitionIndex: callerIndex,
        outputIndex: 0,
      }),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "program-mismatch",
      expectedProgram: "gold_token.aleo",
      actualProgram: "probe_records.aleo",
    });
  });

  it("not-a-ciphertext when selector points at the caller's own id-only output slot", async () => {
    const handle = await getHandle();
    const callerIndex = handle.transitions.findIndex(
      (t) => t.programId === "probe_records.aleo" && t.transitionName === "wrap_mint_gold",
    );
    expect(callerIndex).toBeGreaterThanOrEqual(0);

    // Projector with `program: "probe_records.aleo"` matches the caller's
    // transition so we get past the program-mismatch check; the output at
    // index 0 is the id-only entry itself, surfacing not-a-ciphertext.
    const callerSelfProjector = {
      program: "probe_records.aleo",
      recordName: "WrappedToken",
      deserialize: (s: string) => s,
    };

    await expect(
      handle.decryptFrom(callerSelfProjector, bob(), {
        transitionIndex: callerIndex,
        outputIndex: 0,
      }),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "not-a-ciphertext",
    });
  });
});
