// COMMITTED authored suite. The adapter copies it into
// generated/dynamic_dispatch/test/ (generated projects are gitignored, so
// authored tests cannot live inside them). Runtime green requires a devnode;
// the lane runs it via `lionden test` (sequential, no proving). Typechecked
// against the generated bindings.
//
// Exercises the dynamic-dispatch surface no other sample touches, mapped to the
// generated method shapes + error hierarchy:
//   .locally                       — call.dynamic runs offline (leo run)
//   .accepted (EncryptedValue)      — settle_rebalance, runtime-target-selected,
//                                     decrypt the private u64 outputs
//   mappings.lastSplit.get          — runtime target selection is observable as
//                                     distinct read-back state (iface vs alt)
//   .accepted (id-only handles)     — intrinsic_rebalance (dyn records),
//                                     mint_external (external record + dyn view)
//   IdOnlyRecordResolutionError      — wrong .from/.at source on an id-only handle
//   .rejected / OnChainRejectedError — V15-unbacked dyn record, dispatched
//                                     mapping/vector finalizer failures
//
// Target field encodings (program-id identifier bytes, little-endian) are the
// runtime dispatch selectors, taken from DYNAMIC_DISPATCH_PLAN.md /
// scripts/devnode_finalize.sh.
import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IdOnlyRecordResolutionError,
  Leo,
  LocalValueDecryptionError,
  MappingKeyNotFoundError,
  OnChainRejectedError,
} from "../typechain/BaseContract.js";
import { createDispatcher, TokenIface_Coin } from "../typechain/Dispatcher.js";
import { createTokenIface } from "../typechain/TokenIface.js";

const TOKEN_IFACE = Leo.field(122570818776591183523835764n);
const TOKEN_ALT = Leo.field(2147631940706897719156n);

async function deployDispatcher() {
  const ctx = await setup();
  try {
    // Deploying dispatcher auto-deploys its transitive program deps
    // (token_iface, token_alt); execution.imports wires the dynamic targets.
    await ctx.deploy("dispatcher", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;
const dispatcher = createDispatcher();
const tokenIface = createTokenIface();

beforeAll(async () => {
  const fixture = await loadFixture(deployDispatcher);
  ctx = fixture.ctx;
  dispatcher.connect(ctx.lre);
  tokenIface.connect(ctx.lre);
});

afterAll(async () => {
  if (ctx) await ctx.teardown();
  else clearFixtures();
});

describe("dynamic_dispatch — local call.dynamic (.locally)", () => {
  it("settle_rebalance dispatches offline and returns two shares", async () => {
    const [major, minor] = await dispatcher.settle_rebalance.locally(TOKEN_IFACE, 100n);
    expect(typeof major).toBe("bigint");
    expect(typeof minor).toBe("bigint");
    // token_iface implements an even split: major == minor for equal inputs.
    expect(major).toBe(minor);
  });
});

describe("dynamic_dispatch — offline dyn-record cast (probe_cast)", () => {
  it("probe_cast casts a Coin to `dyn record` and reads its field offline", async () => {
    // Self-contained `c as dyn record` cast + field read with no dynamic call —
    // the off-chain dyn-record-cast regression upstream built it for. Runs under
    // `leo run` with no ledger.
    expect(await tokenIface.probe_cast.locally(42n)).toBe(42n);
  });
});

describe("dynamic_dispatch — runtime target selection is observable", () => {
  it("settle_rebalance against token_iface is accepted and records last_split", async () => {
    const result = await dispatcher.settle_rebalance.accepted(TOKEN_IFACE, 100n);
    expect(result.status).toBe("accepted");
    // Private u64 outputs are EncryptedValue handles; decrypt with the signer.
    const [major, minor] = result.outputs;
    const majorVal = await major.decrypt(ctx!.accounts[0]!.privateKey);
    const minorVal = await minor.decrypt(ctx!.accounts[0]!.privateKey);
    expect(majorVal).toBe(minorVal); // even split
    expect(await dispatcher.mappings.lastSplit.get(TOKEN_IFACE)).toBe(majorVal);
  });

  it("settle_rebalance against token_alt records a DIFFERENT split (75/25)", async () => {
    await dispatcher.settle_rebalance.accepted(TOKEN_ALT, 100n);
    const ifaceSplit = await dispatcher.mappings.lastSplit.get(TOKEN_IFACE);
    const altSplit = await dispatcher.mappings.lastSplit.get(TOKEN_ALT);
    // token_alt's policy is a 75/25 split, so the recorded major differs from
    // token_iface's even split — runtime target selection is observable.
    expect(altSplit).not.toBe(ifaceSplit);
  });

  it("decrypting a private output with the wrong key throws LocalValueDecryptionError", async () => {
    const result = await dispatcher.settle_rebalance.accepted(TOKEN_IFACE, 40n);
    const [major] = result.outputs;
    await expect(major.decrypt(ctx!.accounts[1]!.privateKey)).rejects.toBeInstanceOf(
      LocalValueDecryptionError,
    );
  });

  it("reading last_split at an unset key throws MappingKeyNotFoundError", async () => {
    await expect(dispatcher.mappings.lastSplit.get(Leo.field(987654321n))).rejects.toBeInstanceOf(
      MappingKeyNotFoundError,
    );
  });
});

describe("dynamic_dispatch — id-only record outputs (V15-backed)", () => {
  it("intrinsic_rebalance returns two dyn-record handles", async () => {
    const result = await dispatcher.intrinsic_rebalance.accepted(TOKEN_IFACE, 50n);
    expect(result.status).toBe("accepted");
    const [a, b] = result.outputs;
    expect(a.kind).toBe("idOnlyDynamicRecord");
    expect(b.kind).toBe("idOnlyDynamicRecord");
  });

  it("mint_external surfaces an external record handle that resolves to a Coin", async () => {
    const result = await dispatcher.mint_external.accepted(20n);
    const [coinHandle, dynHandle] = result.outputs;
    expect(coinHandle.kind).toBe("idOnlyExternalRecord");
    expect(dynHandle.kind).toBe("idOnlyDynamicRecord");
    // The Coin ciphertext lives on the token_iface `issue` callee transition;
    // bind the source by name and decrypt with the owner (signer) key.
    const coin = await coinHandle
      .match(TokenIface_Coin.output.from("issue", 0))
      .decrypt(ctx!.accounts[0]!.privateKey);
    expect(coin.amount).toBe(20n);
  });
});

describe("dynamic_dispatch — IdOnlyRecordResolutionError (bad source binding)", () => {
  const signer = () => ctx!.accounts[0]!.privateKey;

  it("an unknown .from transition name throws reason transition-not-found", async () => {
    const result = await dispatcher.mint_external.accepted(7n);
    const [coinHandle] = result.outputs;
    const err = await coinHandle
      .match(TokenIface_Coin.output.from("not_a_transition", 0))
      .decrypt(signer())
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(IdOnlyRecordResolutionError);
    expect((err as IdOnlyRecordResolutionError).reason).toBe("transition-not-found");
  });

  it("an out-of-range .at transition index throws reason transition-index-out-of-range", async () => {
    const result = await dispatcher.mint_external.accepted(7n);
    const [coinHandle] = result.outputs;
    const err = await coinHandle
      .match(TokenIface_Coin.output.at(999, 0))
      .decrypt(signer())
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(IdOnlyRecordResolutionError);
    expect((err as IdOnlyRecordResolutionError).reason).toBe("transition-index-out-of-range");
  });
});

describe("dynamic_dispatch — V15 record-existence rejection", () => {
  // The V15 local record-existence check rejects this: the backing static
  // Receipt is never output. The chain surfaces it as a broadcast-time
  // execution-verification failure (not a finalizer reject), so the only robust
  // assertion is that .accepted does NOT resolve.
  //
  // This check is an INCLUSION/proving-time concern. The no-prove devnode
  // fast-path skips it, and the two backends diverge there: `leo devnode`
  // happens to reject anyway, but the standalone `aleo-devnode` no-prove path
  // ACCEPTS the unbacked record. Verified (Jun 2026) that under `--prove` BOTH
  // backends reject it. So gate the assertion on proving — it is deterministic
  // and backend-independent under `--prove`, and a no-prove run can't enforce it
  // on the standalone backend. (See README § Findings.)
  it.skipIf(process.env["LIONDEN_PROVE"] !== "true")(
    "unbacked_dyn outputs only a locally-minted dyn record and does not succeed",
    async () => {
      await expect(dispatcher.unbacked_dyn.accepted(9n)).rejects.toThrow();
    },
  );
});

describe("dynamic_dispatch — dispatched mapping/vector reads (finalizer)", () => {
  // Use a fresh account so the balance is exactly what this suite writes,
  // independent of any state other tests leave on the shared devnode.
  const who = () => Leo.address(ctx!.accounts[2]!.address);

  it("populates token_iface state, then assert_balance is accepted for the known balance", async () => {
    await tokenIface.record_supply.accepted(who(), 7n);
    const result = await dispatcher.assert_balance.accepted(TOKEN_IFACE, who(), 7n);
    expect(result.status).toBe("accepted");
  });

  it("assert_history_at(0) is accepted once history is non-empty", async () => {
    const result = await dispatcher.assert_history_at.accepted(TOKEN_IFACE, 0);
    expect(result.status).toBe("accepted");
  });

  it("assert_balance on a missing key is rejected (dispatched mapping .get)", async () => {
    const result = await dispatcher.assert_balance.rejected(
      TOKEN_IFACE,
      Leo.address(ctx!.accounts[3]!.address),
      0n,
    );
    expect(result.status).toBe("rejected");
  });

  it("assert_history_at(99) is rejected out of bounds (dispatched vector .get)", async () => {
    const result = await dispatcher.assert_history_at.rejected(TOKEN_IFACE, 99);
    expect(result.status).toBe("rejected");
  });

  it("calling .accepted on the out-of-bounds read throws OnChainRejectedError", async () => {
    await expect(dispatcher.assert_history_at.accepted(TOKEN_IFACE, 99)).rejects.toBeInstanceOf(
      OnChainRejectedError,
    );
  });
});
