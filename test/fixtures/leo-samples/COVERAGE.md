# leo-samples lane — binding-method & error coverage audit (P7)

The lane exists to exercise lionden's generated-binding **method shapes** and
**error hierarchy** end-to-end — the surface the existing example smoke lanes
barely touch. This matrix maps every generated method shape and every exported
error class to the test(s) that trigger it, and flags the shapes left
uncovered (with where they *are* covered instead). It is a manual audit;
re-run the greps in this file after editing the suites.

Suites audited: `suites/native_runtime_edges/`, `suites/dynamic_dispatch/`,
`suites/upgradability/`, `gapfiller/test/` (the gap-filler is hand-authored,
not adapted). `abi_surface` has **no** on-chain suite — see the codegen finding
in the README and `adapter/specs.ts` (`compileOnly`).

## Error classes → trigger

| Error class | Suite | Concrete trigger |
| --- | --- | --- |
| `TransitionInputError` | gapfiller | `echo_u8(999)` — out of range, rejected before execution |
| `LocalTransitionError` | native_runtime_edges | overflow `255+1`, underflow `0-1`, div-by-zero `1/0`, off-chain `assert(false)` via `.captureLocalFailure` |
| `UnexpectedLocalSuccessError` | native_runtime_edges | `.failsLocally` on a passing input |
| `OnChainRejectedError` | native_runtime_edges, dynamic_dispatch | `.accepted(...)` on a rejecting finalizer — `finalizer_assert(false)`, out-of-bounds vector read (`vector_set_at`, dispatched `assert_history_at`), bare `get(credits.aleo::account, <unfunded>)` via `native_account_required_read` |
| `UnexpectedTransactionStatusError` | native_runtime_edges | `.rejected(...)` on a *passing* finalizer |
| `MappingKeyNotFoundError` | dynamic_dispatch | `mappings.lastSplit.get(<unset key>)` |
| `IdOnlyRecordResolutionError` | dynamic_dispatch | bad source binding on an id-only handle — `transition-not-found` (`.from("not_a_transition")`), `transition-index-out-of-range` (`.at(999, 0)`) |
| `RecordDecryptionKeyError` | gapfiller | malformed key string passed to `.decrypt` |
| `LocalRecordDecryptionError` | gapfiller | wrong view key decrypting a record output |
| `LocalValueDecryptionError` | dynamic_dispatch | wrong view key decrypting an `EncryptedValue` (settle_rebalance private u64) |
| `TransitionSubmissionError` | — (gap) | network-level submission failure; non-deterministic on a fast no-proving devnode. Covered by `packages/network` unit tests. |
| `TransactionConfirmationTimeoutError` | — (gap) | requires a stalled/slow node; non-deterministic here. Covered by `packages/network` unit tests. |
| `TransactionShapeError` | — (gap) | internal malformed-output guard; not reachable from well-formed bindings. Covered by `packages/leo-compiler/src/codegen/base-contract.test.ts`. |

10 of 13 error classes are exercised on-chain by the lane; the 3 gaps are
network/internal failure modes that have dedicated unit coverage.

### `IdOnlyRecordResolutionReason` (6 reasons)

Covered on-chain: `transition-not-found`, `transition-index-out-of-range`.
The other four (`transition-not-unique`, `transition-match-index-out-of-range`,
`program-mismatch`, `not-a-ciphertext`) need a specific multi-call callgraph
shape to construct deterministically and are covered by
`packages/leo-compiler/src/codegen/base-contract.test.ts` (e.g. the
`not-a-ciphertext` cases). The lane proves the reason **discrimination** works
end-to-end with two representative reasons.

## Method shapes → reference count

Counts are **raw greppable references** across the four suites, produced by the
method-shape block in [How to re-audit](#how-to-re-audit) — they include mentions
in comments and `it(...)` descriptions, so they are a reference count, not a
unique call-site count. Re-run that block after editing the suites and update the
numbers here to match.

| Shape | Count | Where |
| --- | --- | --- |
| `.locally` | 20 | all suites — pure compute / view round-trips, dynamic `call.dynamic`, offline `probe_cast` dyn-record cast |
| `.captureLocalFailure` | 5 | native_runtime_edges |
| `.failsLocally` | 5 | native_runtime_edges |
| `.accepted` | 30 | native_runtime_edges (finalizer asserts, native `credits.aleo::account` reads, vector/storage edges, `transfer_public_signer_wrap` future), dynamic_dispatch, upgradability (`version`) |
| `.rejected` | 13 | native_runtime_edges (finalizer/vector/storage/native-read rejects), dynamic_dispatch |
| `mappings.lastSplit.get` | 5 | dynamic_dispatch — runtime target read-back (the other mapping accessors `getOrUse`/`contains`/`tryGet` are 0 here; covered by `packages/leo-compiler` base-contract unit tests) |
| id-only `.match` / `.from` / `.at` / `.decrypt` | 3 / 2 / 1 / 9 | dynamic_dispatch, gapfiller |
| `.submitted` | 0 (gap) | the fire-and-forget primitive that `.accepted`/`.settled` build on; covered by `packages/leo-compiler` base-contract unit tests |
| `.settled` | 0 (gap) | settle-to-either-status; `.accepted`/`.rejected` (the status-asserting forms) are heavily exercised instead; raw `.settled` covered by unit tests |

The upgrade lifecycle (`deploy` v1 → in-place v2 swap → `upgrade` task →
accept/reject by constructor policy) is exercised by the upgradability suite
across `@noupgrade` / `@custom` / `@admin` / `@checksum` (the two upgrade
sub-cases that need a per-LRE signer override or a pre-broadcast checksum
capture are `it.skip` with documented reasons).

## How to re-audit

Two independent passes — the **error-class** table (which suites reference each
class) and the **method-shape** table (raw reference counts). The error-class
loop counts *files* (`grep -l`); the method-shape loop counts *occurrences*
(`grep -oE`). Run both from the lane root after editing the suites.

```bash
cd test/fixtures/leo-samples
SUITES=(suites/*/*.test.ts gapfiller/test/*.test.ts)
# error classes (file count → "which suites trigger this class"):
for E in TransitionInputError LocalTransitionError UnexpectedLocalSuccessError \
  OnChainRejectedError UnexpectedTransactionStatusError MappingKeyNotFoundError \
  IdOnlyRecordResolutionError RecordDecryptionKeyError LocalRecordDecryptionError \
  LocalValueDecryptionError TransitionSubmissionError \
  TransactionConfirmationTimeoutError TransactionShapeError; do
  printf '%-38s' "$E"; grep -lF "$E" "${SUITES[@]}" 2>/dev/null | wc -l
done

# method shapes (occurrence count → the "Method shapes" table):
for S in '\.locally' '\.captureLocalFailure' '\.failsLocally' '\.accepted' \
  '\.rejected' '\.getOrUse' '\.contains' '\.tryGet' \
  '\.match\(' '\.from\(' '\.at\(' '\.decrypt\(' 'mappings\.[A-Za-z]+\.get\b'; do
  printf '%-32s' "$S"; grep -roE "$S" "${SUITES[@]}" 2>/dev/null | wc -l | tr -d ' '
done
```
