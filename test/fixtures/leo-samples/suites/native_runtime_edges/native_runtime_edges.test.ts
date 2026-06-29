// COMMITTED authored suite. The adapter copies it into
// generated/native_runtime_edges/test/ (generated projects are gitignored, so
// authored tests cannot live inside them). Runtime green requires a devnode;
// the lane runs it via `lionden test` per generated project (sequential, no
// proving). Typechecked against the generated bindings.
//
// Maps the native runtime-edge surface to the generated error hierarchy:
//   .locally                      — pure compute
//   .captureLocalFailure          — LocalTransitionError (overflow/underflow/div0/assert)
//   .failsLocally                 — asserts a local failure (UnexpectedLocalSuccessError otherwise)
//   .accepted / .rejected         — on-chain finalizer accept/reject
//   .accepted on a rejecting tx   — OnChainRejectedError
import { clearFixtures, loadFixture, setup, type TestContext } from "@lionden/testing";
import { PrivateKey } from "@provablehq/sdk/testnet.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Leo,
  LocalTransitionError,
  OnChainRejectedError,
  UnexpectedLocalSuccessError,
  UnexpectedTransactionStatusError,
} from "../typechain/BaseContract.js";
import { createNativeRuntimeEdges } from "../typechain/NativeRuntimeEdges.js";

// A syntactically valid address that is NOT one of the four pre-funded devnode
// accounts. Those each hold ~23.4T microcredits, so they ALL have a
// `credits.aleo::account` entry — only a freshly generated, never-funded address
// has no entry, which is what `native_account_required_read` needs to reject.
// Wrapped with Leo.address for the binding's AddressInput.
const UNFUNDED_ADDRESS = Leo.address(new PrivateKey().to_address().to_string());

async function deployNre() {
  const ctx = await setup();
  try {
    // Deploying native_runtime_edges deploys its transitive program deps
    // (credit_left, credit_right) too; credits.aleo is a network dep already on
    // the devnode.
    await ctx.deploy("native_runtime_edges", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;
const nre = createNativeRuntimeEdges();

beforeAll(async () => {
  const fixture = await loadFixture(deployNre);
  ctx = fixture.ctx;
  nre.connect(ctx.lre);
});

afterAll(async () => {
  if (ctx) await ctx.teardown();
  else clearFixtures();
});

describe("native_runtime_edges — local compute (.locally)", () => {
  it("checked_add_overflow(1, 2) = 3", async () => {
    expect(await nre.checked_add_overflow.locally(1, 2)).toBe(3);
  });

  it("transition_assert(true) = true", async () => {
    expect(await nre.transition_assert.locally(true)).toBe(true);
  });
});

describe("native_runtime_edges — local failures → LocalTransitionError", () => {
  it("checked_add_overflow(255, 1) overflows", async () => {
    const err = await nre.checked_add_overflow.captureLocalFailure(255, 1);
    expect(err).toBeInstanceOf(LocalTransitionError);
    expect(err.kind).toBe("LocalTransitionError");
  });

  it("checked_sub_underflow(0, 1) underflows", async () => {
    const err = await nre.checked_sub_underflow.captureLocalFailure(0, 1);
    expect(err.kind).toBe("LocalTransitionError");
  });

  it("checked_division(1, 0) divides by zero", async () => {
    const err = await nre.checked_division.captureLocalFailure(1n, 0n);
    expect(err.kind).toBe("LocalTransitionError");
  });

  it("transition_assert(false) fails the off-chain assert", async () => {
    const err = await nre.transition_assert.captureLocalFailure(false);
    expect(err.kind).toBe("LocalTransitionError");
  });

  it(".failsLocally resolves for a genuinely failing input", async () => {
    await expect(nre.checked_add_overflow.failsLocally(255, 1)).resolves.toBeUndefined();
  });

  it(".failsLocally on a passing input throws UnexpectedLocalSuccessError", async () => {
    await expect(nre.transition_assert.failsLocally(true)).rejects.toBeInstanceOf(
      UnexpectedLocalSuccessError,
    );
  });
});

describe("native_runtime_edges — on-chain finalizer accept/reject", () => {
  it("finalizer_assert(true) is accepted", async () => {
    const result = await nre.finalizer_assert.accepted(true);
    expect(result.status).toBe("accepted");
    expect(result.txId).toBeTruthy();
  });

  it("finalizer_assert(false) is rejected", async () => {
    const result = await nre.finalizer_assert.rejected(false);
    expect(result.status).toBe("rejected");
  });

  it("calling .accepted on a rejecting finalizer throws OnChainRejectedError", async () => {
    await expect(nre.finalizer_assert.accepted(false)).rejects.toBeInstanceOf(OnChainRejectedError);
  });

  it("calling .rejected on a passing finalizer throws UnexpectedTransactionStatusError", async () => {
    await expect(nre.finalizer_assert.rejected(true)).rejects.toBeInstanceOf(
      UnexpectedTransactionStatusError,
    );
  });

  it("missing_mapping_get(404field) rejects on a missing key", async () => {
    const result = await nre.missing_mapping_get.rejected(Leo.field(404));
    expect(result.status).toBe("rejected");
  });

  it("vector_get_at(99) rejects out-of-bounds", async () => {
    const result = await nre.vector_get_at.rejected(99);
    expect(result.status).toBe("rejected");
  });
});

describe("native_runtime_edges — native credits mapping reads (diamond-on-credits)", () => {
  // The point of the diamond-on-credits sample: finalizers that read the native
  // `credits.aleo::account` mapping cross-program at runtime.
  it("native_account_safe_read uses get_or_use → accepted for any address", async () => {
    // Zero state dependency: get_or_use falls back to 0u64, so this is the
    // guaranteed-robust anchor regardless of funding.
    const result = await nre.native_account_safe_read.accepted(
      Leo.address(ctx!.accounts[0]!.address),
    );
    expect(result.status).toBe("accepted");
  });

  it("native_account_required_read rejects for an address with no credits.aleo::account entry", async () => {
    // Bare get(credits.aleo::account, owner) panics on a missing key.
    const result = await nre.native_account_required_read.rejected(UNFUNDED_ADDRESS);
    expect(result.status).toBe("rejected");
  });

  it("calling .accepted on the required read of an unfunded address throws OnChainRejectedError", async () => {
    await expect(
      nre.native_account_required_read.accepted(UNFUNDED_ADDRESS),
    ).rejects.toBeInstanceOf(OnChainRejectedError);
  });
});

describe("native_runtime_edges — storage & vector finalizer edges", () => {
  // `field_history` / `group_history` are never populated at runtime
  // (`initialize_runtime_state` is never called) and the storage singletons are
  // unset — so every index is out of bounds and every unwrap panics.
  it("vector_set_at(0) rejects out-of-bounds on the empty field_history", async () => {
    const result = await nre.vector_set_at.rejected(0, Leo.field(7));
    expect(result.status).toBe("rejected");
  });

  it("calling .accepted on the out-of-bounds vector_set_at throws OnChainRejectedError", async () => {
    await expect(nre.vector_set_at.accepted(0, Leo.field(7))).rejects.toBeInstanceOf(
      OnChainRejectedError,
    );
  });

  it("vector_swap_remove_at(0) rejects out-of-bounds on the empty group_history", async () => {
    const result = await nre.vector_swap_remove_at.rejected(0);
    expect(result.status).toBe("rejected");
  });

  it("missing_storage_unwrap rejects on the unset required_field singleton", async () => {
    const result = await nre.missing_storage_unwrap.rejected();
    expect(result.status).toBe("rejected");
  });
});

describe("native_runtime_edges — native credits future composition", () => {
  it("transfer_public_signer_wrap runs credits.aleo::transfer_public_as_signer and is accepted", async () => {
    // Wraps `credits.aleo::transfer_public_as_signer(...).run()`, which debits
    // `self.signer` — the genesis account (accounts[0], the default signer) holds
    // ~23.4T public microcredits, so the composed credits future settles.
    // (The sibling `transfer_public_wrapper` uses plain `transfer_public`, which
    // debits `self.caller` == the *program* in a cross-program `.run()`; the
    // program is unfunded, so that one deterministically rejects — wrong shape
    // for an accept test.)
    const result = await nre.transfer_public_signer_wrap.accepted(
      Leo.address(ctx!.accounts[1]!.address),
      1n,
    );
    expect(result.status).toBe("accepted");
  });
});
