// Port of tmp/leo-examples/dynamic_records/ (branch
// mohammadfawaz/dynamic_records @ b208247c). Combines Leo v4 runtime dispatch
// with `dyn record` inputs and outputs, plus an `external_token_demo` program
// that exercises external `Record` outputs and nested-call-graph flows.
//
// The token implementations' `transfer` takes a concrete `Token` and returns
// `(Token, dyn record)` to satisfy snarkVM ConsensusVersion::V15's
// record-existence rule: the root input is consumed as a static record and the
// transferred static record is materialized alongside the dynamic handle so
// the spendable token is recoverable from the callee transition. `balance_of`
// is a pure read of a `dyn record` — under V15 it cannot be a root transition
// on a held token, so it is exercised on dynamic records produced inside the
// execution (mint/transfer outputs) via the router and the receipt flows.
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

import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecordOutputMatcher, Leo } from "../typechain/BaseContract.js";
import { createExternalTokenDemo, GoldToken_Token } from "../typechain/ExternalTokenDemo.js";
import { asGoldToken, createGoldToken } from "../typechain/GoldToken.js";
import { asSilverToken, createSilverToken } from "../typechain/SilverToken.js";
import { createTokenRouter } from "../typechain/TokenRouter.js";

const RUNTIME_IMPORTS = ["gold_token.aleo", "silver_token.aleo"] as const;

// True when the test runner was invoked with `--prove` (LIONDEN_PROVE=true).
//
// Spending a *held* record (one minted in a prior transaction) by passing it as
// a `dyn record` ROOT input is only valid on the devnode fast path, which skips
// inclusion-proof generation. Under real proving, snarkVM must build a ledger-
// inclusion proof for the root input, and a record's on-chain commitment binds
// its originating program (e.g. silver_token.aleo/Token); at a different-program
// root (token_router.aleo / external_token_demo.aleo) the circuit cannot
// reconstruct that commitment, so the ledger reports it as non-existent and the
// transition is rejected before confirmation. This is the V15 "a dynamic value
// carried across transactions is only a view" rule — see
// docs/research/dynamic-records-v15.md § Held Records And Inclusion Proofs.
//
// `route_transfer` / `dispatch_and_receipt` can only be called with a held
// record (their record input is a `dyn record` parameter), so those flows are
// asserted as fast-path successes when not proving and as V15 rejections when
// proving. Flows that mint *inside* the execution (`demo_transfer`, etc.) never
// cross a transaction boundary and prove cleanly in both modes.
const PROVING = process.env["LIONDEN_PROVE"] === "true";

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

  it("gold_token.transfer.accepted consumes Token and emits [EncryptedRecord<Token>, IdOnlyDynamicRecordHandle]", async () => {
    const minted = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 555n,
      purity: 18n,
    });

    const accepted = await gold.withSigner(alice()).transfer.accepted({
      token: await minted.outputs.decrypt(alice()),
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

  it("silver_token.transfer.accepted consumes Token and emits [EncryptedRecord<Token>, IdOnlyDynamicRecordHandle]", async () => {
    const minted = await silver.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 800n,
      grade: 2n,
    });

    const accepted = await silver.withSigner(alice()).transfer.accepted({
      token: await minted.outputs.decrypt(alice()),
      to: bob(),
    });

    const concrete = await accepted.outputs[0].decrypt(bob());
    expect(concrete.owner).toBe(bob().address);
    expect(concrete.amount).toBe(800n);
    expect(concrete.grade).toBe(2n);

    expect(accepted.outputs[1].kind).toBe("idOnlyDynamicRecord");
  });

  // Negative guard: locks in the intentional V15 contract that `balance_of`
  // (a pure `dyn record` read) cannot be a root transition on a held token.
  // The input is a non-static root record that is never consumed as a static
  // record, so snarkVM's V15 `ensure_records_exist` rejects the execution at
  // posting time. A held token's balance can only be read on-chain by first
  // producing the record inside the execution (see read_balance /
  // issue_receipt, which mint internally) or client-side by decrypting it.
  it("direct balance_of on a held token is rejected by the V15 record-existence check", async () => {
    const minted = await gold.withSigner(alice()).mint_custom.accepted({
      owner: alice(),
      amount: 111n,
      purity: 5n,
    });
    const held = await minted.outputs.decrypt(alice());

    await expect(
      gold.withSigner(alice()).balance_of.accepted({ token: asGoldToken(held) }),
    ).rejects.toThrow(
      /Non-static record input at r0 of the root function gold_token\.aleo\/balance_of is not known to correspond to a record on the ledger/,
    );
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

  it("read_balance reads an internally minted dynamic record via pure-read balance_of", async () => {
    const result = await router.read_balance.accepted({
      token_program: Leo.identifier("gold_token"),
      owner: alice(),
      amount: 777n,
    });

    expect(await result.outputs.decrypt(alice())).toBe(777n);
    // balance_of is a pure read now: its callee transition emits a single u64
    // output (no reissued Token alongside it).
    const callee = result.transitions.find(
      (t: { readonly programId: string; readonly transitionName: string }) =>
        t.programId === "gold_token.aleo" && t.transitionName === "balance_of",
    );
    expect(callee?.rawOutputs).toHaveLength(1);
  });

  // route_transfer takes its token as a `dyn record` parameter, so it can only
  // ever be called with a record held from a prior transaction. Without --prove
  // the devnode fast path skips inclusion-proof generation and the held record
  // is "spent", so the matcher recovers the materialized sibling. This is a
  // fast-path convenience, not a real on-chain spend.
  it.skipIf(PROVING)(
    "route_transfer (devnode fast-path) surfaces IdOnlyDynamicRecordHandle; .match recovers the silver sibling",
    async () => {
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
    },
  );

  // Under real proving the same call is rejected before confirmation: the held
  // record entering as a `dyn record` root input has no reconstructable on-chain
  // commitment at the token_router.aleo root, so snarkVM cannot build its
  // inclusion proof (the ledger reports the commitment as non-existent). See the
  // PROVING note at the top of this file.
  it.runIf(PROVING)(
    "route_transfer with a held record is rejected under V15 proving (no spendable root commitment)",
    async () => {
      const minted = await silver.withSigner(alice()).mint_custom.accepted({
        owner: alice(),
        amount: 1200n,
        grade: 2n,
      });

      await expect(
        router.route_transfer.accepted({
          token_program: Leo.identifier("silver_token"),
          token: asSilverToken(await minted.outputs.decrypt(alice())),
          to: bob(),
        }),
      ).rejects.toMatchObject({
        kind: "TransitionSubmissionError",
        programId: "token_router.aleo",
        transition: "route_transfer",
      });
    },
  );

  it("gold_beats_silver mints both sides internally and compares balances", async () => {
    const result = await router.gold_beats_silver.accepted({
      owner: alice(),
      gold_amount: 900n,
      silver_amount: 300n,
    });

    expect(await result.outputs.decrypt(alice())).toBe(true);
  });

  it("per-call runtime imports feed has_more without router constructor imports", async () => {
    const result = await perCallRouter.has_more.accepted(
      {
        prog_a: Leo.identifier("gold_token"),
        prog_b: Leo.identifier("silver_token"),
        owner: alice(),
        amount_a: 250n,
        amount_b: 400n,
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
      to_a: alice(),
      to_b: bob(),
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

    // First transfer materialized a Token for alice. Under V15 the
    // intermediate record is consumed by the second transfer, so it must still
    // belong to the root signer.
    const recoveredFirst = await accepted.outputs
      .match(asGoldToken.output.from("transfer", 0, { match: 0 }))
      .decrypt(alice());
    expect(recoveredFirst.owner).toBe(alice().address);
    expect(recoveredFirst.amount).toBe(1000n);

    // Second transfer materialized a Token for bob (passed as to_b).
    const recoveredSecond = await accepted.outputs
      .match(asGoldToken.output.from("transfer", 0, { match: 1 }))
      .decrypt(bob());
    expect(recoveredSecond.owner).toBe(bob().address);
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

  it("issue_receipt: mints internally, reads via pure-read balance_of, emits a concrete Receipt", async () => {
    const accepted = await demo.withSigner(alice()).issue_receipt.accepted({
      token_program: Leo.identifier("gold_token"),
      owner: alice(),
      amount: 500n,
      to: bob(),
    });

    const receipt = await accepted.outputs.decrypt(bob());
    expect(receipt.owner).toBe(bob().address);
    expect(receipt.balance).toBe(500n);
    const callee = accepted.transitions.find(
      (t: { readonly programId: string; readonly transitionName: string }) =>
        t.programId === "gold_token.aleo" && t.transitionName === "balance_of",
    );
    expect(callee?.rawOutputs).toHaveLength(1);
  });

  // dispatch_and_receipt accepts the token as a root `dyn record` (a held
  // record), forwards it into the concrete `transfer`, and emits a concrete
  // Receipt. Without --prove the fast path skips inclusion proofs, so the held
  // record is materialized and the final Receipt decrypts.
  it.skipIf(PROVING)(
    "dispatch_and_receipt (devnode fast-path): intermediate dyn-record dispatch does not poison the concrete final output",
    async () => {
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
    },
  );

  // Under real proving the held-record root input cannot be inclusion-proven at
  // the external_token_demo.aleo root, so the whole transaction (including the
  // concrete Receipt output) is rejected before confirmation. See the PROVING
  // note at the top of this file.
  it.runIf(PROVING)(
    "dispatch_and_receipt with a held record is rejected under V15 proving (no spendable root commitment)",
    async () => {
      const minted = await gold.withSigner(alice()).mint_custom.accepted({
        owner: alice(),
        amount: 700n,
        purity: 9n,
      });

      await expect(
        demo.withSigner(alice()).dispatch_and_receipt.accepted({
          token_program: Leo.identifier("gold_token"),
          token: asGoldToken(await minted.outputs.decrypt(alice())),
          to: bob(),
        }),
      ).rejects.toMatchObject({
        kind: "TransitionSubmissionError",
        programId: "external_token_demo.aleo",
        transition: "dispatch_and_receipt",
      });
    },
  );
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
    await expect(handle.match(missingMatcher.from("nope", 0)).decrypt(bob())).rejects.toMatchObject(
      {
        kind: "IdOnlyRecordResolutionError",
        reason: "transition-not-found",
      },
    );
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
  const router = createTokenRouter({ imports: RUNTIME_IMPORTS });
  const alice = () => ctx!.accounts[0]!;
  const bob = () => ctx!.accounts[1]!;

  beforeAll(() => {
    router.connect(ctx!.lre);
  });

  // Produce an IdOnlyDynamicRecordHandle via `demo_transfer`, which mints the
  // token *inside* the execution and routes it through `transfer`. Unlike
  // `route_transfer` (a held-record / dyn-record-root spend), this proves
  // cleanly, so these matcher-resolution negative cases run in both the
  // fast-path and --prove lanes. The handle's callgraph contains
  // `gold_token.aleo/mint` and `gold_token.aleo/transfer` plus the router's own
  // `token_router.aleo/demo_transfer` root.
  async function dynHandle() {
    const accepted = await router.demo_transfer.accepted({
      token_program: Leo.identifier("gold_token"),
      owner: alice(),
      amount: 11n,
      to: bob(),
    });
    expect(accepted.outputs.kind).toBe("idOnlyDynamicRecord");
    return accepted.outputs;
  }

  it("transition-not-found when the named callee isn't in the dyn handle's callgraph", async () => {
    const handle = await dynHandle();
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
    const handle = await dynHandle();
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
    const handle = await dynHandle();
    // The router's own transition at output index 0 is the dyn-record id-only
    // entry. Use a router-program matcher to bypass program-mismatch.
    const routerSelfMatcher = createRecordOutputMatcher<unknown>({
      program: "token_router.aleo",
      recordName: "Routed",
      deserialize: (s: string) => s,
    });
    await expect(
      handle.match(routerSelfMatcher.from("demo_transfer", 0)).decrypt(bob()),
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
    await expect(minted.outputs.match(asSilverToken.output).decrypt(alice())).rejects.toMatchObject(
      {
        kind: "TransactionShapeError",
      },
    );
  });
});
