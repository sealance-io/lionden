# Leo v3.5.0 Backwards Compatibility — Probe Findings

This document records empirical findings from the Phase 0 bug-hunt probe suite
(`tmp/bug-hunts/`). Each probe tests a specific v3.5 compatibility lane against
LionDen's existing pipeline. Findings are authoritative over assumptions in the
plan (`async-humming-wave.md`).

---

## Probe 1: leo-v35-deploy-v4-node

**Goal:** Compile a v3.5 program with the v3.5 compiler, deploy to a v4-equivalent
devnode, execute transitions (sync + finalize), read mapping state.

**Status:** PASSED (all 3 tests green)

**Scope note:** This probe uses `leoVersion: "4.0.0"` in the LionDen config and
swaps the actual binary via a PATH shim. It proves that v3.5 compiler output can
pass through the current v4-configured LionDen pipeline (after the two fixes
below). It does **not** prove that `leoVersion: "3.5.0"` config support works —
that requires config validation changes not yet implemented.

### Test Program

`deposit_prog.aleo` — v3.5 syntax with:
- `transition` / `async transition` keywords (not v4's `fn`)
- `-> Future` return type (not v4's `-> Final`)
- Separate `async function finalize_X()` (not v4's inline `return final { ... }`)
- `@noupgrade async constructor() {}` (v3.5 async constructor syntax)
- `mapping balances: address => u64`
- `Mapping::get_or_use()` / `Mapping::set()` in finalize

### Phases and Results

| Phase | Result | Notes |
|-------|--------|-------|
| Compile (v3.5 CLI via PATH shim) | PASS | `leo build --path ... --enable-dce` works identically to v4 |
| ABI parse + codegen | PASS | After bug fix (see below) |
| TypeScript typecheck | PASS | Generated `DepositProg.ts` typechecks cleanly |
| Deploy to v4 devnode | PASS | SDK `buildDevnodeDeploymentTransaction()` works with v3.5 bytecode. Devnode requires `--consensus-heights "0,1,2,3,4,5,6,7,8"` (see observation 8). |
| Execute deposit (finalize path) | PASS | `depositBroadcast(100n)` returns valid txId |
| Read mapping state | PASS | `getBalances(address)` returns `>= 100n` |
| Execute sum (sync/local) | PASS | `sum(3, 5)` returns `8` |

### Bugs Found and Fixed

#### Bug 1: ABI parser doesn't normalize `"Future"` string output type

**File:** `packages/leo-compiler/src/abi-parser.ts:232`

v3.5 ABI emits `"Future"` as the output type for async transitions. The parser
only handled `"Final"` (v4 form). Error: `Cannot use 'in' operator to search for 'Plaintext' in Future`.

**Fix:**
```typescript
// Before:
if (raw === "Final") return { Future: programId };
// After:
if (raw === "Final" || raw === "Future") return { Future: programId };
```

**Regression test:** `abi-parser.test.ts` — "normalizes bare 'Future' string
output to Future (v3.5 ABI format)"

#### Bug 2: Constructor parser rejects v3.5 `async constructor()` syntax

**File:** `packages/plugin-deploy/src/constructor-parser.ts:36-49`

All 4 regex patterns (`NOUPGRADE_RE`, `ADMIN_RE`, `CHECKSUM_RE`, `CUSTOM_RE`)
expected `annotation ... constructor(` with no `async` keyword in between. v3.5
uses `@noupgrade async constructor() {}`, so `parseConstructor()` returned `null`
and the deploy pipeline threw a hard error.

**Fix:** Inserted `(?:async\s+)?` before `constructor` in all 4 patterns:
```typescript
// Example (NOUPGRADE_RE):
// Before:
/@noupgrade\s+(?:\/\/[^\n]*\n\s*)*constructor\s*\(/
// After:
/@noupgrade\s+(?:\/\/[^\n]*\n\s*)*(?:async\s+)?constructor\s*\(/
```

**Regression tests:** `constructor-parser.test.ts` — 4 new tests:
- "parses @noupgrade async constructor (v3.5 syntax)"
- "parses @admin async constructor (v3.5 syntax)"
- "parses @checksum async constructor (v3.5 syntax)"
- "parses @custom async constructor (v3.5 syntax)"

### Key Observations

1. **`add` is a reserved opcode in v3.5 Leo.** A function named `add` conflicts
   with the Aleo `add` instruction. Renamed to `sum` in the test program. This
   is not a LionDen bug — just a naming constraint for v3.5 programs.

2. **v3.5 ABI format uses `"transitions"` (not `"functions"`), `"is_async"` (not
   `"is_final"`), and `"Future"` output type (not `"Final"`).** The ABI parser's
   existing `transitions`/`functions` and `is_async`/`is_final` normalization
   works correctly. Only the `"Future"` string literal was missing.

3. **v3.5 compiled bytecode (`main.aleo`) is structurally identical to v4:**
   - Uses `function` keyword (compiled IR, not Leo source keywords)
   - `finalize deposit:` sections (same as v4)
   - `constructor:` section with `assert.eq edition 0u16;` — **matches v4
     exactly**
   - Future outputs: `deposit_prog.aleo/deposit.future` (same as v4)

4. **Constructor fingerprint roundtrip works.** `extractConstructorFingerprint()`
   produces `""` (empty string) for `@noupgrade`, matching v4 behavior. The
   deploy manifest writes and reads correctly.

5. **v3.5 build flags are compatible.** `--enable-dce`, `--conditional-block-max-depth`,
   `--build-tests`, `--path` all exist in v3.5.0.

6. **`program.json` format is compatible.** The package materializer's output
   (with `description: ""` and `license: "MIT"`) works for v3.5's `leo build`.

7. **Constructor annotations exercised in Probe 1:** Only `@noupgrade` was
   exercised in the committed probe source and end-to-end test. `@admin`,
   `@custom`, and `@checksum` were confirmed to compile successfully via ad hoc
   manual `leo build` commands during development, but do not have Probe 1 test
   coverage. The regression tests in `constructor-parser.test.ts` cover
   `parseConstructor()` for all 4 annotation + `async` combinations at the unit
   level.

8. **Devnode requires `--consensus-heights` for constructor programs.** Without
   this flag, the devnode rejects deploy transactions with: _"program uses syntax
   that is not allowed before `ConsensusVersion::V9`"_. The required flag format
   is `--consensus-heights "0,1,2,3,4,5,6,7,8"` — comma-delimited, monotonically
   increasing block numbers, length = target consensus version. The probe runner
   (`run-probe.sh`) passes this flag to the devnode. `DevnodeManager`
   (`packages/network/src/devnode-manager.ts`) does not yet pass this flag and
   will need updating.

9. **SDK compatibility confirmed.** `@provablehq/sdk@^0.10.1`'s
   `buildDevnodeDeploymentTransaction()` and `buildDevnodeExecutionTransaction()`
   work with v3.5-compiled bytecode without modification.

### Reproducibility

The probe runner at `tmp/bug-hunts/leo-v35-deploy-v4-node/run-probe.sh`:
- Requires `LEO_V35` and `LEO_V4` env vars pointing to the respective binaries
- Asserts the expected version string before each phase
- Passes `--consensus-heights "0,1,2,3,4,5,6,7,8"` to the devnode
- Fails closed — any phase failure exits the script with non-zero status

```bash
LEO_V35=~/.leo/bin/leo-3.5 LEO_V4=$(which leo) \
  ./tmp/bug-hunts/leo-v35-deploy-v4-node/run-probe.sh
```

### Artifacts

- Source: `tmp/bug-hunts/leo-v35-deploy-v4-node/programs/deposit_prog/main.leo`
- Compiled: `tmp/bug-hunts/leo-v35-deploy-v4-node/artifacts/deposit_prog.aleo/main.aleo`
- ABI: `tmp/bug-hunts/leo-v35-deploy-v4-node/artifacts/deposit_prog.aleo/abi.json`
- Deploy manifest: `tmp/bug-hunts/leo-v35-deploy-v4-node/artifacts/deposit_prog.aleo/deploy.json`
- Typechain: `tmp/bug-hunts/leo-v35-deploy-v4-node/typechain/DepositProg.ts`
- Tests: `tmp/bug-hunts/leo-v35-deploy-v4-node/test/deploy-and-execute.test.ts`

---

## Probe 2: leo-v35-upgrade-v35-cli-v4-node

_Pending_

---

## Probe 3: leo-v35-to-v4-upgrade

_Pending_

---

## Probe 4: leo-v35-cross-program

_Pending_

---

## Probe 5: leo-v35-library

_Pending_
