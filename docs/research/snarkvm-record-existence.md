# snarkVM `ensure_records_exist` (Consensus V15)

When to read this: use this file when authoring a Leo program that mixes static records and `dyn record` (the dynamic-dispatch input/output type), or when investigating a transaction whose confirmed-transaction dump shows only id-only `record_dynamic` entries. The rule below is upstream snarkVM behaviour, not a LionDen-side concern — but LionDen example programs and codegen are shaped around it.

For end-user typechain behaviour of id-only record outputs, use [`../network.md`](../network.md). For Leo compiler version compatibility, use [`../leo-version-compatibility.md`](../leo-version-compatibility.md).

## Summary

`ConsensusVersion::V15` adds an execution-time and verification-time predicate called `ensure_records_exist`. The predicate rejects executions in which a `DynamicRecord` or `ExternalRecord` value is used (output, passed to a function call) without being grounded in a concrete static `Record` that exists on the ledger by the end of execution.

Upstream history:

- snarkVM PR [#3109 `[WIP] Ensure records are linked`](https://github.com/ProvableHQ/snarkVM/pull/3109) — closed unmerged 2026-03-04. Established the rule but used a narrower "passed downstream" check that the review surfaced as insufficient.
- snarkVM PR [#3173 `Ensure records exist`](https://github.com/ProvableHQ/snarkVM/pull/3173) — merged 2026-03-25 at commit `d652b3355b963c9d409178a01f041f28004162c4`. Final implementation.
- snarkVM issue [#2667 `Don't allow unchecked External Records in Aleo Programs`](https://github.com/ProvableHQ/snarkVM/issues/2667) — the original problem statement.

## The rule

The merged `ensure_records_exist` enforces two related properties on every execution under V15:

- **Global check.** Every `DynamicRecord` or `ExternalRecord` input to the root call must be connected through the execution to a static `Record` that exists on the ledger.
- **Local check.** If a function locally mints a static `Record` and either passes it to a function call, or casts it to a `DynamicRecord` that is then output or passed to a function call, that function must also output the exact static record register it was cast from.

A function that **receives** a `DynamicRecord` from a callee may output or forward it without owing materialization — the callee's own contract already ties the dynamic value back to a static record on the ledger.

Where the predicate runs:

- Execution / proving path: [`synthesizer/src/vm/execute.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/synthesizer/src/vm/execute.rs) calls `ensure_records_exist` when V15 is active.
- Verification path: [`synthesizer/process/src/verify_execution/mod.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/synthesizer/process/src/verify_execution/mod.rs) calls `ensure_records_exist` when `consensus_version >= ConsensusVersion::V15`.
- Implementation: [`synthesizer/process/src/verify_execution/ensure_records_exist.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/synthesizer/process/src/verify_execution/ensure_records_exist.rs).

V15 also adds a deployment-time restriction in [`synthesizer/src/vm/verify.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/synthesizer/src/vm/verify.rs): closures cannot output `Record`, `ExternalRecord`, or `DynamicRecord` types. This is related but separate — the local materialization rule is about function executions, not closure outputs.

## Why this isn't a LionDen bug

The predicate lives entirely in snarkVM. The Leo compiler does **not** warn on the offending pattern at compile time — a program shaped like

```leo
fn transfer(token: dyn record, to: address) -> dyn record {
    let new_token: Token = Token { owner: to, ... };
    return new_token as dyn record;
}
```

compiles cleanly today. The failure mode is purely consensus:

- Pre-V15: the transaction is accepted. The confirmed transaction dump shows id-only `record_dynamic` outputs everywhere — even on the producing transition — and there is no recoverable ciphertext anywhere on the chain.
- Post-V15: snarkVM rejects the same transaction at execute and at verify.

If a confirmed transaction dump shows id-only `record_dynamic` outputs and you cannot find a sibling concrete `Record` output (either of type `record` with a `value` ciphertext, or a `record_with_dynamic_id` carrying commitment + checksum + value), the offending program is the cause. This is true regardless of LionDen's typechain emission — the chain has no ciphertext to surface.

Empirically, confirmed transaction dumps captured against a Leo 4.0.x devnode show that a `record_dynamic` output entry is always shaped:

```json
{ "type": "record_dynamic", "id": "<field>" }
```

— no `value`, no `checksum`, no `sender_ciphertext`, no nonce. This holds on both the caller-side transition and the producing callee transition (in nested dispatch). The upstream serializer that produces this shape is [`ledger/block/src/transition/output/serialize.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/ledger/block/src/transition/output/serialize.rs), which emits only `type` and `id` for the `Output::DynamicRecord` variant. There is therefore no ciphertext, checksum, sender ciphertext, or record payload to recover from the dynamic output alone — the client must locate a sibling concrete record output (e.g. `Output::Record` with a `value` ciphertext, or `record_with_dynamic_id`) elsewhere in the callgraph.

## LionDen stance

1. **Do not author cast-and-drop dyn-record patterns** in `examples/`, scaffolds, throwaway probes, or any new program. Every `let r: T = T { ... }; return r as dyn record;` pattern is a V15 violation if `r` is locally minted and not also output as a static `Record`.
2. **The V15-compliant idiom** is to emit the static record alongside the dynamic handle, e.g. `fn transfer(...) -> (Token, dyn record)` returning `(new_token, new_token as dyn record)`. The canonical port that demonstrates this is `examples/aleo-ports/dynamic_records/programs/{gold_token,silver_token}/main.leo`.
3. **Acceptance on a pre-V15 devnet is not proof of correctness.** Local devnodes may or may not activate V15 at low block heights — see the consensus-activation table below. A green local test against a non-V15 devnet does not mean the program will execute under upstream consensus.
4. **Treat id-only-everywhere transactions as program bugs**, not LionDen-typechain bugs. The typechain surfaces honest `IdOnlyDynamicRecordHandle` / `IdOnlyExternalRecordHandle` types; the absence of a recoverable sibling output is a property of the Leo program, not of the SDK or codegen.

## Recoverability under V15

A plain `record_dynamic` output is id-only on every transition (caller and callee). The dynamic ID is **not** a dereferenceable ciphertext pointer. Two distinct id-only outputs in the same transaction can carry the same id, and there is no rule the typechain can apply to decide which transition "produced" the canonical ciphertext.

The recoverable path is the sibling concrete output that a V15-compliant callee materialized:

- LionDen's `IdOnlyDynamicRecordHandle.decryptFrom(projector, key, source)` selects an explicit sibling concrete output in the same callgraph. It does **not** dereference the dynamic-record id.
- LionDen's `IdOnlyExternalRecordHandle<T>.decryptFrom(projector, key, source)` selects the callee transition that emitted an external `Record` value.
- Selection is always explicit (named `{ programId, transitionName, outputIndex, transitionMatchIndex? }` or positional `{ transitionIndex, outputIndex }`). There is no id-based auto-resolution by design.

See [`../network.md`](../network.md) § Id-only record outputs for the full client-side flow.

## Consensus activation

`ConsensusVersion::V15` is defined in [`console/network/src/consensus_heights.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/console/network/src/consensus_heights.rs). Upstream defaults inspected during this work:

| Network | V15 activation height |
| --- | --- |
| Canary | `u32::MAX` (not active) |
| Mainnet | `u32::MAX` (not active) |
| Testnet | `u32::MAX` (not active) |
| `test_consensus_heights` | `18` |

LionDen devnodes follow Leo's `devnode start` defaults (see [`../leo-version-compatibility.md`](../leo-version-compatibility.md) § Devnode Consensus Heights for V9 / constructor support). To pin a specific consensus-height table, use `networks.devnode.consensusHeights` in the project config. Without explicit configuration, do not assume the devnode activates V15.

## Practical authoring checklist

When writing a new Leo program that involves `dyn record`:

1. Identify every place where a static `Record` is locally minted and then cast to `dyn record`. If the cast value is output or passed to another function, the static record must also be output by the same function.
2. Prefer tuple returns `(T, dyn record)` over `dyn record` alone. The tuple shape composes cleanly with V15 and with LionDen's typechain emission (`[EncryptedRecord<T>, IdOnlyDynamicRecordHandle]`).
3. Avoid closures with `Record` / `ExternalRecord` / `DynamicRecord` outputs — V15 rejects them at deploy time.
4. Read every `confirmed.transitions[*].rawOutputs` entry before concluding a record is recoverable. An id-only entry on the surfacing transition does **not** imply the same id is decryptable elsewhere in the callgraph — empirically the chain never exposes a ciphertext for the `record_dynamic` variant itself.
5. If you must consume the dynamic value alone (e.g. routing through a generic interface), recover the spendable record from the callee's sibling concrete output via explicit `decryptFrom(...)` selection, not from the dynamic ID.

## Migration outcome for `examples/aleo-ports/dynamic_records`

When migrating the `dynamic_records` port, two upstream questions had to be resolved empirically before locking in the public API:

1. **Does Leo accept a tuple return type containing both a concrete record and a `dyn record` in an interface declaration?**
2. **Does Leo accept a dynamic caller that destructures such a tuple via `let result: (dyn record, dyn record) = Interface@(target)::fn(...); return result.1;`?**

Both questions were answered by compiling a pair of throwaway programs under Leo 4.0.x:

- A `tuple_probe.aleo` implementer declared `fn xfer(t: dyn record, to: address) -> (Tok, dyn record);` in its interface and returned `(n, n as dyn record);` — compiled cleanly.
- A `tuple_caller.aleo` dynamic caller destructured the dispatch result as `(dyn record, dyn record)` and returned `result.1;` — compiled cleanly.

LionDen's typechain emission for those probes confirmed the public API shape: `[EncryptedRecord<Tok>, IdOnlyDynamicRecordHandle]` on the implementer's `.accepted` return, and `IdOnlyDynamicRecordHandle` on the dynamic caller's. The port therefore landed on the primary tuple-return design across `gold_token`, `silver_token`, `token_router`, and `external_token_demo` — every locally-minted static record at the producer is now also output as a sibling concrete record, satisfying `ensure_records_exist`.

A simpler fallback (`fn transfer(...) -> Token;` returning the concrete record directly, with no `dyn record` in the return position) would also be V15-compliant. It was not chosen because the dual-output design preserves the dispatched `dyn record` API at every interface boundary, which is the feature the port is meant to demonstrate.

## Reference index

snarkVM:

- [PR #3173 `Ensure records exist`](https://github.com/ProvableHQ/snarkVM/pull/3173) — merged
- [PR #3109 `[WIP] Ensure records are linked`](https://github.com/ProvableHQ/snarkVM/pull/3109) — closed unmerged
- [Issue #2667](https://github.com/ProvableHQ/snarkVM/issues/2667) — original problem
- [`ensure_records_exist.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/synthesizer/process/src/verify_execution/ensure_records_exist.rs)
- [`verify_execution/mod.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/synthesizer/process/src/verify_execution/mod.rs)
- [`vm/execute.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/synthesizer/src/vm/execute.rs)
- [`vm/verify.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/synthesizer/src/vm/verify.rs)
- [`transition/output/serialize.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/ledger/block/src/transition/output/serialize.rs)
- [`consensus_heights.rs`](https://github.com/ProvableHQ/snarkVM/blob/staging/console/network/src/consensus_heights.rs)

Leo (related but not enforcing):

- [PR #29232 dynamic records language feature](https://github.com/ProvableHQ/leo/pull/29232)
- [PR #29233 dynamic operation intrinsics](https://github.com/ProvableHQ/leo/pull/29233)
- [PR #29269 enforce `dyn record` for record types in dynamic calls](https://github.com/ProvableHQ/leo/pull/29269)
