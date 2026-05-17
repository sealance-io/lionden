// Port of tmp/leo-examples/dynamic_records/ (branch
// mohammadfawaz/dynamic_records @ b208247c). Combines Leo v4 runtime dispatch
// with `dyn record` inputs and outputs, plus an `external_token_demo` program
// that exercises external `Record` outputs and nested-call-graph flows.
//
// The token implementations' `transfer` returns `(Token, dyn record)` to
// satisfy snarkVM ConsensusVersion::V15's `ensure_records_exist` rule (see
// `docs/research/snarkvm-record-existence.md`): the static record is
// materialized alongside the dynamic handle so the spendable token is
// recoverable from the callee transition.
//
// Output-side typing:
//   - Idiomatic call sites use generated helpers for both directions:
//     `asGoldToken(token)` builds a `dyn record` input, and
//     `asGoldToken.output.from("transfer", 0)` names the concrete sibling
//     output to decrypt.
//   - Direct `gold_token.transfer.accepted` / `silver_token.transfer.accepted`
//     emit `[EncryptedRecord<Token>, IdOnlyDynamicRecordHandle]` (tuple).
//   - Router `route_transfer` / `demo_transfer` still return a single
//     `IdOnlyDynamicRecordHandle` (their public return is `dyn record`).
//     `.match(asXxx.output.from(transition, idx)).decrypt(key)` recovers the
//     materialized sibling concrete `Token` from the callee transition — it
//     does NOT dereference the dynamic-record id.
//   - External `Record` outputs surface as `IdOnlyExternalRecordHandle<T>`;
//     the ciphertext lives on the callee transition, recovered via the
//     matcher API.
//   - Local concrete records (including from dyn-input transitions) keep
//     emitting `EncryptedRecord<T>` and can decrypt directly; `.match`
//     gives the same uniform API with a program/recordName identity guard.
//   - `.at(...)` and `createRecordOutputMatcher(...)` are escape hatches for
//     positional selection, negative tests, or unresolved external ABIs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setup,
  loadFixture,
  clearFixtures,
  type TestContext,
} from "@lionden/testing";
import { Leo, createRecordOutputMatcher } from "../typechain/BaseContract.js";
import { asGoldToken, createGoldToken } from "../typechain/GoldToken.js";
import { asSilverToken, createSilverToken } from "../typechain/SilverToken.js";
import { createTokenRouter } from "../typechain/TokenRouter.js";
import { createExternalTokenDemo, GoldToken_Token } from "../typechain/ExternalTokenDemo.js";

const RUNTIME_IMPORTS = ["gold_token.aleo", "silver_token.aleo"] as const;

async function deployDynamicRecords() {
  const ctx = await setup();
  try {
    await ctx.deploy("gold_token", { noCompile: true });
    await ctx.deploy("silver_token", { noCompile: true });
    await ctx.deploy("token_router", { noCompile: true });
    await ctx.deploy("external_token_demo", { noCompile: true });
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

  it("gold_token.mint_custom.accepted supports the uniform .match(...).decrypt API", async () => {
    const confirmed = await gold.mint_custom.accepted({
      owner: owner(),
      amount: 1000n,
      purity: 24n,
    });
    const token = await confirmed.outputs.match(asGoldToken.output).decrypt(owner());

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

describe("V15-compliant transfer materialization", () => {
  const gold = createGoldToken();
  const silver = createSilverToken();
  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    gold.connect(ctx!.lre);
    silver.connect(ctx!.lre);
  });

  it("gold_token.transfer.accepted emits [EncryptedRecord<Token>, IdOnlyDynamicRecordHandle]", async () => {
    const minted = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 555n,
      purity: 18n,
    });

    const accepted = await gold.withSigner(alice()).transfer.accepted({
      token: asGoldToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });

    const concrete = await accepted.outputs[0].decrypt(bob());
    expect(concrete.owner).toBe(bob().address);
    expect(concrete.amount).toBe(555n);
    expect(concrete.purity).toBe(18n);

    expect(accepted.outputs[1].kind).toBe("idOnlyDynamicRecord");
    expect(accepted.outputs[1].type).toBe("record_dynamic");
    expect(accepted.outputs[1].id).toMatch(/^[0-9]+field$/);
  });

  it("silver_token.transfer.accepted emits [EncryptedRecord<Token>, IdOnlyDynamicRecordHandle]", async () => {
    const minted = await silver.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 800n,
      grade: 2n,
    });

    const accepted = await silver.withSigner(alice()).transfer.accepted({
      token: asSilverToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });

    const concrete = await accepted.outputs[0].decrypt(bob());
    expect(concrete.owner).toBe(bob().address);
    expect(concrete.amount).toBe(800n);
    expect(concrete.grade).toBe(2n);

    expect(accepted.outputs[1].kind).toBe("idOnlyDynamicRecord");
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

  it("demo_transfer surfaces IdOnlyDynamicRecordHandle; .match recovers the gold sibling", async () => {
    const accepted = await router.demo_transfer.accepted({
      token_program: Leo.identifier("gold_token"),
      owner: alice(),
      amount: 1000n,
      to: alice(),
    });

    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");
    expect(accepted.outputs.type).toBe("record_dynamic");
    expect(accepted.outputs.id).toMatch(/^[0-9]+field$/);
    expect(accepted.outputs.transitions.length).toBeGreaterThan(0);

    const transferred = await accepted.outputs
      .match(asGoldToken.output.from("transfer", 0))
      .decrypt(alice());
    expect(transferred.owner).toBe(alice().address);
    expect(transferred.amount).toBe(1000n);
  });

  it("demo_transfer surfaces IdOnlyDynamicRecordHandle; .match recovers the silver sibling", async () => {
    const accepted = await router.demo_transfer.accepted({
      token_program: Leo.identifier("silver_token"),
      owner: alice(),
      amount: 2000n,
      to: alice(),
    });

    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");
    expect(accepted.outputs.type).toBe("record_dynamic");

    const transferred = await accepted.outputs
      .match(asSilverToken.output.from("transfer", 0))
      .decrypt(alice());
    expect(transferred.owner).toBe(alice().address);
    expect(transferred.amount).toBe(2000n);
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

  it("route_transfer surfaces IdOnlyDynamicRecordHandle; .match recovers the silver sibling", async () => {
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

    const transferred = await accepted.outputs
      .match(asSilverToken.output.from("transfer", 0))
      .decrypt(bob());
    expect(transferred.owner).toBe(bob().address);
    expect(transferred.amount).toBe(1200n);
    expect(transferred.grade).toBe(2n);
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

  it("demo_double_transfer disambiguates two transfer transitions via .from(name, idx, { match })", async () => {
    const accepted = await router.demo_double_transfer.accepted({
      token_program: Leo.identifier("gold_token"),
      owner: alice(),
      amount: 1000n,
      to_a: bob(),
      to_b: alice(),
    });

    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");

    // Two `gold_token.aleo/transfer` transitions appear in the callgraph;
    // calling `.from("transfer", 0)` without `{ match }` is ambiguous and
    // must throw `transition-not-unique`.
    await expect(
      accepted.outputs.match(asGoldToken.output.from("transfer", 0)).decrypt(bob()),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "transition-not-unique",
    });

    // First transfer materialized a Token for bob.
    const recoveredFirst = await accepted.outputs
      .match(asGoldToken.output.from("transfer", 0, { match: 0 }))
      .decrypt(bob());
    expect(recoveredFirst.owner).toBe(bob().address);
    expect(recoveredFirst.amount).toBe(1000n);

    // Second transfer materialized a Token for alice (passed as to_b).
    const recoveredSecond = await accepted.outputs
      .match(asGoldToken.output.from("transfer", 0, { match: 1 }))
      .decrypt(alice());
    expect(recoveredSecond.owner).toBe(alice().address);
    expect(recoveredSecond.amount).toBe(1000n);
  });
});

describe("external_token_demo external + nested record outputs", () => {
  const gold = createGoldToken();
  const demo = createExternalTokenDemo({ imports: ["gold_token.aleo", "silver_token.aleo"] });

  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    gold.connect(ctx!.lre);
    demo.connect(ctx!.lre);
  });

  it("wrap_mint_gold returns IdOnlyExternalRecordHandle<GoldToken_Token>; idiomatic .from(...) recovers the callee token", async () => {
    const accepted = await demo.withSigner(alice()).wrap_mint_gold.accepted({
      to: bob(),
      amount: 100n,
    });

    expect(accepted.outputs.kind).toBe("idOnlyExternalRecord");
    expect(accepted.outputs.type).toBe("external_record");

    const token = await accepted.outputs
      .match(GoldToken_Token.output.from("mint", 0))
      .decrypt(bob());

    expect(token.owner).toBe(bob().address);
    expect(token.amount).toBe(100n);
  });

  it("wrap_mint_gold can use the positional .at(...) escape hatch", async () => {
    const accepted = await demo.withSigner(alice()).wrap_mint_gold.accepted({
      to: bob(),
      amount: 50n,
    });

    // The callee transition (`gold_token.mint`) is the one that actually
    // holds the record ciphertext. Find its index in the callgraph.
    const calleeIndex = accepted.outputs.transitions.findIndex(
      (t: { readonly programId: string; readonly transitionName: string }) =>
        t.programId === "gold_token.aleo" && t.transitionName === "mint",
    );
    expect(calleeIndex).toBeGreaterThanOrEqual(0);

    const token = await accepted.outputs
      .match(GoldToken_Token.output.at(calleeIndex, 0))
      .decrypt(bob());
    expect(token.owner).toBe(bob().address);
    expect(token.amount).toBe(50n);
  });

  it("issue_receipt: concrete Receipt output is decryptable even though inputs are dyn record", async () => {
    const minted = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 500n,
      purity: 12n,
    });

    const accepted = await demo.withSigner(alice()).issue_receipt.accepted({
      token_program: Leo.identifier("gold_token"),
      token: asGoldToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });

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

    const accepted = await demo.withSigner(alice()).dispatch_and_receipt.accepted({
      token_program: Leo.identifier("gold_token"),
      token: asGoldToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });

    // Final Receipt has a real ciphertext on external_token_demo's own
    // transition, even though the intermediate `gold_token.transfer` call
    // returned a tuple whose dynamic member is id-only.
    const receipt = await accepted.outputs.decrypt(bob());
    expect(receipt.owner).toBe(bob().address);
    expect(receipt.balance).toBe(700n);

    // The callee transfer transition is reachable and exposes the materialized
    // Token at output index 0 (sibling concrete record). Presence check only —
    // dedicated recovery flows are covered by the runtime-dispatch describe.
    const transferCallee = accepted.transitions.find(
      (t: { readonly programId: string; readonly transitionName: string }) =>
        t.programId === "gold_token.aleo" && t.transitionName === "transfer",
    );
    expect(transferCallee).toBeDefined();
  });
});

describe("IdOnlyExternalRecordHandle .match negative cases", () => {
  const demo = createExternalTokenDemo({ imports: ["gold_token.aleo", "silver_token.aleo"] });
  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    demo.connect(ctx!.lre);
  });

  async function getHandle() {
    const accepted = await demo.withSigner(alice()).wrap_mint_gold.accepted({
      to: bob(),
      amount: 1n,
    });
    expect(accepted.outputs.kind).toBe("idOnlyExternalRecord");
    return accepted.outputs;
  }

  it("transition-not-found when the named transition isn't in the callgraph", async () => {
    const handle = await getHandle();
    // Construct an ad-hoc matcher pointed at a non-existent program so .from(...)
    // inherits that programId — exercises the unresolved-external-record matcher
    // construction path even though we already have a typed helper.
    const missingMatcher = createRecordOutputMatcher<unknown>({
      program: "missing.aleo",
      recordName: "Foo",
      deserialize: (s: string) => s,
    });
    await expect(
      handle.match(missingMatcher.from("nope", 0)).decrypt(bob()),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "transition-not-found",
    });
  });

  it("transition-index-out-of-range for .at(...) past the callgraph", async () => {
    const handle = await getHandle();
    await expect(
      handle.match(GoldToken_Token.output.at(999, 0)).decrypt(bob()),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "transition-index-out-of-range",
    });
  });

  it("program-mismatch when matcher points at a different program than the selected transition", async () => {
    const handle = await getHandle();
    const callerIndex = handle.transitions.findIndex(
      (t: { readonly programId: string; readonly transitionName: string }) =>
        t.programId === "external_token_demo.aleo" && t.transitionName === "wrap_mint_gold",
    );
    expect(callerIndex).toBeGreaterThanOrEqual(0);

    await expect(
      handle.match(GoldToken_Token.output.at(callerIndex, 0)).decrypt(bob()),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "program-mismatch",
      expectedProgram: "gold_token.aleo",
      actualProgram: "external_token_demo.aleo",
    });
  });

  it("not-a-ciphertext when selector points at the caller's own id-only output slot", async () => {
    const handle = await getHandle();
    const callerIndex = handle.transitions.findIndex(
      (t: { readonly programId: string; readonly transitionName: string }) =>
        t.programId === "external_token_demo.aleo" && t.transitionName === "wrap_mint_gold",
    );
    expect(callerIndex).toBeGreaterThanOrEqual(0);

    // Matcher points at the caller's own program so we pass the
    // program-mismatch guard; the output at index 0 is the id-only entry
    // itself, surfacing not-a-ciphertext.
    const callerSelfMatcher = createRecordOutputMatcher<unknown>({
      program: "external_token_demo.aleo",
      recordName: "WrappedToken",
      deserialize: (s: string) => s,
    });

    await expect(
      handle.match(callerSelfMatcher.at(callerIndex, 0)).decrypt(bob()),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "not-a-ciphertext",
    });
  });
});

describe("IdOnlyDynamicRecordHandle .match negative cases", () => {
  const gold = createGoldToken();
  const silver = createSilverToken();
  const router = createTokenRouter({ imports: RUNTIME_IMPORTS });
  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    gold.connect(ctx!.lre);
    silver.connect(ctx!.lre);
    router.connect(ctx!.lre);
  });

  async function routeGold() {
    const minted = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 11n,
      purity: 7n,
    });
    const accepted = await router.route_transfer.accepted({
      token_program: Leo.identifier("gold_token"),
      token: asGoldToken(await minted.outputs.decrypt(alice())),
      to: bob(),
    });
    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");
    return accepted.outputs;
  }

  it("transition-not-found when the named callee isn't in the dyn handle's callgraph", async () => {
    const handle = await routeGold();
    // Build a matcher pointed at a missing program; .from inherits that program id.
    const missingMatcher = createRecordOutputMatcher<unknown>({
      program: "missing.aleo",
      recordName: "Token",
      deserialize: (s: string) => s,
    });
    await expect(
      handle.match(missingMatcher.from("transfer", 0)).decrypt(bob()),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "transition-not-found",
    });
  });

  it("program-mismatch when the matcher points at a different program than the selected transition", async () => {
    const handle = await routeGold();
    // Named .from(...) on the silver matcher targets silver_token.aleo/transfer,
    // which doesn't exist in the callgraph — that would surface
    // transition-not-found, not program-mismatch. To exercise program-mismatch
    // we must select positionally via .at(...) so the matcher's program can
    // differ from the selected transition's program.
    const calleeIndex = handle.transitions.findIndex(
      (t: { readonly programId: string; readonly transitionName: string }) =>
        t.programId === "gold_token.aleo" && t.transitionName === "transfer",
    );
    expect(calleeIndex).toBeGreaterThanOrEqual(0);
    await expect(
      handle.match(asSilverToken.output.at(calleeIndex, 0)).decrypt(bob()),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "program-mismatch",
      expectedProgram: "silver_token.aleo",
      actualProgram: "gold_token.aleo",
    });
  });

  it("not-a-ciphertext when the selector points at the router's own id-only output slot", async () => {
    const handle = await routeGold();
    // The router's own transition at output index 0 is the dyn-record id-only
    // entry. Use a router-program matcher to bypass program-mismatch.
    const routerSelfMatcher = createRecordOutputMatcher<unknown>({
      program: "token_router.aleo",
      recordName: "Routed",
      deserialize: (s: string) => s,
    });
    await expect(
      handle.match(routerSelfMatcher.from("route_transfer", 0)).decrypt(bob()),
    ).rejects.toMatchObject({
      kind: "IdOnlyRecordResolutionError",
      reason: "not-a-ciphertext",
    });
  });
});

describe("EncryptedRecord .match identity guard", () => {
  const gold = createGoldToken();
  const alice = () => ctx!.accounts[0]!;

  beforeAll(() => {
    gold.connect(ctx!.lre);
  });

  it("rejects with TransactionShapeError when matcher program/recordName differ from the ciphertext's identity", async () => {
    const minted = await gold.mint_custom.accepted({
      owner: alice(),
      amount: 42n,
      purity: 10n,
    });

    // The minted output is an EncryptedRecord<Token> for gold_token.aleo/Token.
    // Passing the silver matcher must reject — the deserializer assumes the
    // wrong record layout and the program identity does not match.
    await expect(
      minted.outputs.match(asSilverToken.output).decrypt(alice()),
    ).rejects.toMatchObject({
      kind: "TransactionShapeError",
    });
  });
});
