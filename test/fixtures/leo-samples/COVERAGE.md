# leo-samples lane — binding-method & error coverage audit (P7)

The lane exists to exercise lionden's generated-binding **method shapes** and
**error hierarchy** end-to-end — the surface the existing example smoke lanes
barely touch. This matrix maps every generated method shape and every exported
error class to the test(s) that trigger it, and flags the shapes left
uncovered (with where they *are* covered instead). It is a manual audit;
re-run the greps in this file after editing the suites.

Suites audited: `suites/native_runtime_edges/`, `suites/dynamic_dispatch/`,
`gapfiller/test/` (the gap-filler is hand-authored, not adapted). `abi_surface`
has **no** on-chain suite — see the codegen finding in the README and
`adapter/specs.ts` (`compileOnly`).

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
| `.accepted` | 30 | native_runtime_edges (finalizer asserts, native `credits.aleo::account` reads, vector/storage edges, `transfer_public_signer_wrap` future), dynamic_dispatch |
| `.rejected` | 13 | native_runtime_edges (finalizer/vector/storage/native-read rejects), dynamic_dispatch |
| `mappings.lastSplit.get` | 5 | dynamic_dispatch — runtime target read-back (the other mapping accessors `getOrUse`/`contains`/`tryGet` are 0 here; covered by `packages/leo-compiler` base-contract unit tests) |
| id-only `.match` / `.from` / `.at` / `.decrypt` | 3 / 2 / 1 / 9 | dynamic_dispatch, gapfiller |
| `.submitted` | 0 (gap) | the fire-and-forget primitive that `.accepted`/`.settled` build on; covered by `packages/leo-compiler` base-contract unit tests |
| `.settled` | 0 (gap) | settle-to-either-status; `.accepted`/`.rejected` (the status-asserting forms) are heavily exercised instead; raw `.settled` covered by unit tests |

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

## Code-coverage opportunities

The matrix above audits *binding-method shapes*. This section audits **Istanbul
line/branch coverage** of the three core modules the lane drives — leo-compiler
(incl. codegen), network, plugin-deploy — and ranks low-runtime ways to raise it.

**How to produce the report.** Run the coverage lane and open the HTML:

```bash
npm run build                               # on-chain CLI resolves plugins via dist
npm run test:smoke:leo-samples:coverage     # = run-leo-samples.mjs --coverage
open coverage/smoke/leo-samples/index.html  # per-package / per-file pages
```

`--coverage` requires the full lane (devnode + on-chain suites): the runner
writes one coverage **blob** per on-chain project plus one `in-process.json` blob
for the compile/codegen suite, all into
`.vitest/smoke-coverage/leo-samples/blobs/`, then `vitest --merge-reports` unions
them into the HTML. `--coverage --no-onchain` is *not* a supported coverage path
— it produces only the in-process text-summary (no merged HTML), because the
merge step runs only on the on-chain pass.

### What the three structural fixes changed

Three measurement gaps suppressed the headline numbers; the fixes are
~zero-runtime:

1. **In-process compile/codegen coverage was discarded.** The runner ran the
   in-process `compile-codegen.test.ts` *with* `--coverage` but never captured a
   blob, so only on-chain blobs were merged — and the on-chain `lionden test`
   compile **cache-skips** codegen. The report therefore credited near-zero to
   the codegen source the lane already fully exercises in-process. The runner now
   emits an `in-process.json` blob (gated on `--coverage` + on-chain) that the
   merge unions, crediting the codegen path it actually runs. The in-process
   `vitest.config.ts` additionally aliases `@lionden/*` → each package's
   `src/index.ts` under the same env gate (mirroring the on-chain
   `resolveCoverageAliases`); without it the suite resolves to built `dist` (the
   packages' only `exports` entry), V8 credits `dist`, and the `src`-targeted
   include reports 0% — *and* the in-process blob would key coverage to different
   files than the src-keyed on-chain blobs, so the merge could not union them.
2. **Executed typechain bindings were never instrumented.** The per-project
   generated `typechain/` wrappers are imported (tsx-transpiled) and **executed**
   by the on-chain suites, but the coverage include was hardcoded to
   `packages/*/src/**`. The lane now passes a **per-project** extra include
   (`LIONDEN_TEST_COVERAGE_EXTRA_INCLUDE` →
   `<project>/typechain/**/*.ts`) so V8 credits each project's executed wrappers.
3. **abi_surface has no measurable binding.** It is compile-only: codegen rejects
   it early with `Primitive::Signature is not supported`
   (`assertCodegenSupportedTypes`), before any binding is emitted, so there is
   nothing to instrument — by design.

### Baseline (pre-fix, on-chain-only merged report)

Reconstructed from the on-disk Istanbul report. Regenerate post-fix numbers with
the command above; the codegen rows should move from near-zero to the codegen
path the in-process suite runs, and per-project `typechain/` dirs should appear.

Measured in-process contribution (the `in-process.json` blob alone, merged): the
codegen rows it lifts are `typescript-generator.ts` ≈ 79% lines (718/908, up from
~40% on-chain-only), `type-mapper.ts` ~23% lines (10/44, up from ~5% — the 5
functions `typescript-generator` actually calls), and `codegen-error.ts` 100%
(3/3). `abi-types.ts` is a types-only module (no executable statements), so it
contributes no line denominator. The full merged report ORs this with the
on-chain blobs, so the merged codegen numbers are at least these.

| Module | Stmt % (pre-fix) | Notable cold spots (pre-fix) |
| --- | --- | --- |
| leo-compiler (overall) | 66.7% | codegen sub-tree 38.9% |
| codegen: `type-mapper.ts` | ~5% | only the 5 fns `typescript-generator` calls run on-chain |
| codegen: `typescript-generator.ts` | ~40% | struct/record/serializer emission cache-skipped on-chain |
| codegen: `codegen-error.ts` | 0% | error paths not hit on-chain |
| codegen: `abi-types.ts` | 0% | parsed in-process only |
| network (overall) | 47.9% | `transition-selector` 0%, `file-io` 0%, `named-account-manager` 31%, `sdk-diagnostics` 33% |
| plugin-deploy (overall) | 38.0% | `deployment-state`/`recipe-task` 0%; `deployment-manager` 24%, `preflight` 28% |

### Opportunity ledger (ranked by value ÷ runtime)

| # | Target | Class | Runtime | Status |
| --- | --- | --- | --- | --- |
| 1 | codegen source (`type-mapper`, `typescript-generator`, `abi-types`, `codegen-error`) | **reachable-in-lane** — captured by the in-process blob | ~0 (already paid) | **done** (Task 1) |
| 2 | executed per-project `typechain/**` wrappers + `BaseContract.ts` | **reachable-in-lane** — instrumented on-chain | ~0 (already executed) | **done** (Task 2) |
| 3 | `transition-selector` reentrancy, `file-io`, `sdk-diagnostics`, the 3 network/internal error classes | **delegated-to-unit** | n/a | out of scope |
| 4 | `type-mapper` `primitiveToTs` / `plaintextToTs` / `aleoTypeToTs` | **delegated-to-unit** — no production caller; public API only (`leo-compiler/src/index.ts`) | n/a | out of scope |

### Unit-test delegation boundary

These have dedicated unit coverage and are deliberately **not** re-covered by the
lane (re-covering them adds runtime for no marginal signal):

- mapping accessors `.getOrUse` / `.contains` / `.tryGet`, and `.submitted` /
  `.settled` — `packages/leo-compiler/src/codegen/base-contract.test.ts`.
- the 4 remaining `IdOnlyRecordResolutionReason` reasons (`transition-not-unique`,
  `transition-match-index-out-of-range`, `program-mismatch`, `not-a-ciphertext`)
  — same base-contract unit tests.
- the 3 network/internal error classes (`TransitionSubmissionError`,
  `TransactionConfirmationTimeoutError`, `TransactionShapeError`) — see the
  Error-classes table above.
- `type-mapper`'s `primitiveToTs` / `plaintextToTs` / `aleoTypeToTs` — public-API
  re-exports with no production caller; they belong to type-mapper unit tests,
  not the lane.

### Caveat — per-project `BaseContract.ts`

Every project emits its **own** `BaseContract.ts`, so the merged report lists it
once per project and the roll-up % is conservative (the same ~2.2k lines counted
N times in the denominator). Per-file numbers are sound; the roll-up is not.
**Do not exclude** `BaseContract.ts` — that would drop real binding coverage.
Emitting one shared `BaseContract` is a separate codegen change, out of scope.
