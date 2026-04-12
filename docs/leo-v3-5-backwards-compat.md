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

**Goal:** Deploy a v3.5 `@admin` program (edition 0), modify source (add a new
transition), recompile with v3.5, upgrade on same v4 devnode. Verify edition
increment, constructor fingerprint stability, ABI compatibility checking, and
post-upgrade execution.

**Status:** PASSED (all phases green, 4 tests pass)

**Scope note:** Same as Probe 1 — uses `leoVersion: "4.0.0"` in config with a
PATH shim. Tests the full LionDen upgrade flow (ABI compat check, constructor
immutability validation, fingerprint comparison, edition increment, broadcast)
with v3.5 compiled programs.

### Test Programs

**v1** (`programs-v1/counter_prog/main.leo`, copied into `programs/` at probe start):
- `@admin(address="aleo1rhgdu77...rsvzp9px") async constructor() {}`
- `mapping counter: address => u64`
- `async transition increment(public amount: u64) -> Future`

**v2** (`programs-v2/counter_prog/main.leo`):
- Same constructor, mapping, and `increment` (ABI-compatible)
- **Added:** `async transition reset(public addr: address) -> Future` (sets counter to 0)

### Phases and Results

| Phase | Result | Notes |
|-------|--------|-------|
| Compile v1 (v3.5) | PASS | `@admin async constructor()` compiles to `assert.eq program_owner <address>` |
| Typecheck v1 bindings | PASS | CounterProg.ts with `increment`, `getCounter` |
| Deploy v1 to v4 devnode | PASS | edition 0, fingerprint stored in manifest |
| Verify v1 execution | PASS | `increment(100)` → counter = 100 |
| Swap to v2 source | — | Runner copies `programs-v2/` over `programs/` |
| Upgrade (recompile v2 + broadcast) | PASS | LionDen's upgrade task: ABI compat ✓, constructor immutability ✓, fingerprint match ✓ |
| Typecheck v2 bindings | PASS | CounterProg.ts now includes `reset`, `resetBroadcast` |
| Post-upgrade: increment (old transition) | PASS | `increment(50)` → counter ≥ 150 |
| Post-upgrade: reset (new transition) | PASS | `reset(addr)` → counter = 0 |
| Manifest edition = 1 | PASS | Verified in test |

### Bugs Found and Fixed

None. The upgrade flow works without code changes beyond the two fixes from
Probe 1 (ABI parser `"Future"` normalization and constructor parser `async`
keyword support).

### Key Observations

1. **Both v3.5 and v4 `@admin` constructors use `program_owner`.** The
   compiled `main.aleo` for `@admin(address="aleo1...")` produces identical
   output in both versions:
   ```
   constructor:
       assert.eq program_owner aleo1rhgdu77...rsvzp9px;
   ```
   **Correction:** Earlier in this probe, we speculated that v4 might use
   `self.signer` and include `assert.eq edition`. Probe 3 disproved this —
   v4 also uses `program_owner` with no edition assertion. The v3.5 → v4
   constructor fingerprint is **identical**, and the upgrade path works.

2. **No `assert.eq edition` in `@admin` constructors (either version).** Neither
   v3.5 nor v4 emits an edition assertion in `@admin` constructors. The edition
   is enforced at the protocol/VM level, not in the constructor body. The
   devnode accepts both deploy (edition 0) and upgrade (edition 1+) transactions.

3. **`@noupgrade` DOES include `assert.eq edition 0u16`** (from Probe 1),
   but `@admin` does NOT. This asymmetry exists in both v3.5 and v4.

4. **Constructor fingerprint is stable across v3.5 → v3.5 upgrade.** The
   fingerprint `assert.eq program_owner aleo1...;` is identical before and
   after upgrade (same compiler, same annotation). `extractConstructorFingerprint()`
   correctly extracts and compares it.

5. **ABI compatibility check works with v3.5 ABI format.** Both old and new ABI
   use v3.5 format (`"transitions"`, `"is_async"`, `"Future"`). The ABI parser
   normalizes both identically. Adding `reset` transition (additive change) is
   correctly accepted; no violations reported.

6. **Admin signer prevalidation works.** The upgrade task's
   `validateAdminSigner()` derives the signer address from the devnode
   private key and verifies it matches `constructorAdmin` in the manifest.
   Passed without issue.

7. **Edition increment is correct.** Manifest goes from `edition: 0` to
   `edition: 1`. The upgrade task reads `manifest.edition` and passes
   `edition + 1` to the SDK.

8. **Post-upgrade state is preserved.** The counter value set during v1
   execution (100) persisted through the upgrade. Post-upgrade `increment(50)`
   correctly read the old value and added to it.

9. **New transitions are immediately executable after upgrade.** The `reset`
   transition added in v2 works on the first call after upgrade broadcast.

10. **Probe 3 prediction disproved: fingerprint is identical.** The earlier
    prediction that v4 would compile `@admin` to `self.signer` (different from
    v3.5's `program_owner`) was wrong. Probe 3 confirmed that both v3.5 and v4
    produce `assert.eq program_owner <addr>;` with no `assert.eq edition`. The
    v3.5 → v4 upgrade path works without any code changes.

### Reproducibility

```bash
LEO_V35=~/.leo/bin/leo-3.5 LEO_V4=$(which leo) \
  ./tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/run-probe.sh
```

### Artifacts

- v1 source: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/programs-v1/counter_prog/main.leo`
- active source: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/programs/counter_prog/main.leo` (reset from v1 at probe start, then overwritten by v2 before upgrade)
- v2 source: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/programs-v2/counter_prog/main.leo`
- Compiled: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/artifacts/counter_prog.aleo/main.aleo`
- ABI: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/artifacts/counter_prog.aleo/abi.json`
- Deploy manifest: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/artifacts/counter_prog.aleo/deploy.json`
- Typechain: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/typechain/CounterProg.ts`
- Tests: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/test/v2-upgrade-verify.test.ts`
- Verify script: `tmp/bug-hunts/leo-v35-upgrade-v35-cli-v4-node/scripts/verify-v1.ts`

---

## Probe 3: leo-v35-to-v4-upgrade

**Goal:** Deploy a v3.5 `@admin` program (edition 0), migrate source to v4
syntax (`fn`, `-> Final`, non-async `constructor`, inline `final {}` blocks),
recompile with Leo v4, upgrade on same v4 devnode. Verify the predicted
fingerprint mismatch (or its absence), ABI cross-version compatibility, and
post-upgrade execution.

**Status:** PASSED (all 6 phases green, 4 tests pass)

**Key Result:** The predicted fingerprint mismatch **did not occur**. Both v3.5
and v4 compile `@admin` constructors to identical bytecode (`assert.eq
program_owner <addr>;`). The LionDen upgrade task succeeded without any code
changes.

**Scope note:** Same as Probes 1-2 — uses `leoVersion: "4.0.0"` in config with
a PATH shim. Tests the full v3.5 → v4 version migration path: syntax
conversion, cross-version ABI compatibility, constructor fingerprint stability,
and post-upgrade execution.

### Test Programs

**v1** (`programs-v1/counter_prog/main.leo`, v3.5 syntax):
- `@admin(address="aleo1rhgdu77...rsvzp9px") async constructor() {}`
- `mapping counter: address => u64`
- `async transition increment(public amount: u64) -> Future`
- Separate `async function finalize_increment()` with `Mapping::get_or_use()` / `Mapping::set()`

**v2** (`programs-v2/counter_prog/main.leo`, v4 syntax):
- `@admin(address="aleo1rhgdu77...rsvzp9px") constructor() {}` (no `async`)
- `mapping counter: address => u64`
- `fn increment(public amount: u64) -> Final` with inline `return final { counter.get_or_use(...); counter.set(...); };`
- **Added:** `fn reset(public addr: address) -> Final` (additive ABI change)

### Phases and Results

| Phase | Result | Notes |
|-------|--------|-------|
| Compile v1 (v3.5) | PASS | `@admin async constructor()` compiles to `assert.eq program_owner <addr>` |
| Typecheck v1 bindings | PASS | CounterProg.ts with `increment`, `getCounter` |
| Deploy v1 to v4 devnode | PASS | edition 0, fingerprint = `assert.eq program_owner aleo1...;` |
| Verify v1 execution | PASS | `increment(100)` → counter = 100 |
| Swap to v2 source (v4 syntax) | — | Runner copies `programs-v2/` over `programs/` |
| LionDen upgrade (v3.5→v4) | **PASS** | Full validation: ABI compat ✓, constructor type ✓, admin addr ✓, fingerprint ✓ |
| Direct SDK follow-up upgrade | PASS | Redundant v4-bytecode upgrade after LionDen migration (edition 1→2) |
| Typecheck v2 bindings | PASS | CounterProg.ts includes `reset`, `resetBroadcast` |
| Post-upgrade: increment (old transition) | PASS | `increment(50)` → counter ≥ 150 |
| Post-upgrade: state preserved | PASS | Counter preserved from v3.5 deployment |
| Post-upgrade: reset (new transition) | PASS | `reset(addr)` → counter = 0 |
| Manifest edition | PASS | Edition 1 after LionDen upgrade, then edition 2 after direct SDK follow-up |

### Bugs Found and Fixed

None. The v3.5 → v4 upgrade flow works without code changes beyond the two
fixes from Probe 1 (ABI parser `"Future"` normalization and constructor parser
`async` keyword support).

### Key Observations

1. **v4 `@admin` constructor compiles identically to v3.5.** Both produce:
   ```
   constructor:
       assert.eq program_owner aleo1rhgdu77...rsvzp9px;
   ```
   No `self.signer`, no `assert.eq edition`. The plan's prediction that v4
   would use `self.signer` was based on speculation, not empirical evidence.
   This is the central finding of the probe — it eliminates the predicted
   blocker.

2. **Constructor fingerprint is stable across v3.5 → v4.** The stored
   fingerprint `assert.eq program_owner aleo1...;` from v3.5 deployment
   matches the v4-compiled fingerprint exactly. `extractConstructorFingerprint()`
   works correctly across versions.

3. **ABI cross-version compatibility works.** The old ABI (v3.5 format:
   `"transitions"`, `"is_async"`, `"Future"`) and new ABI (v4 format:
   `"functions"`, `"is_final"`, `"Final"`) both normalize identically through
   `parseAbi()`. `checkAbiCompatibility()` correctly accepts the additive
   `reset` transition.

4. **Compiled IR is structurally identical across versions.** Both v3.5 and v4
   produce the same `main.aleo` structure: `function`/`finalize` sections,
   `async` dispatch with `.future` outputs, `get.or_use`/`add`/`set`
   instructions. The only differences are the added `reset` transition (from
   source change, not version change).

5. **State is preserved across version migration.** Counter value (100) set
   during v3.5 execution persisted through the v4 upgrade. Post-upgrade
   `increment(50)` correctly read and added to the existing value.

6. **New transitions are immediately executable.** The `reset` transition
   added in the v4 source upgrade works on first call.

7. **v4 ABI format differences are cosmetic.** v4 uses `"functions"` (not
   `"transitions"`), `"is_final"` (not `"is_async"`), and `"Final"` (not
   `"Future"`). These are already handled by the ABI parser's normalization.

8. **Admin signer prevalidation works across versions.** The upgrade task's
   `validateAdminSigner()` correctly verifies the signer address against the
   manifest's `constructorAdmin` regardless of which compiler version was used.

9. **Network acceptance is confirmed by the LionDen upgrade broadcast.** The
   LionDen upgrade task builds and broadcasts the v4-compiled upgrade of the
   v3.5-deployed program, so its success proves the devnode accepts the
   migration. The direct SDK phase is only a redundant follow-up upgrade after
   migration (edition 1→2), keeping the low-level SDK path exercised without
   serving as independent proof of the initial v3.5→v4 transition.

10. **The v3.5 → v4 migration path is fully viable.** No code changes needed
    in LionDen, no fingerprint workarounds, no version-conditional logic. Users
    can deploy with v3.5, migrate source to v4 syntax, and upgrade seamlessly.

### Reproducibility

```bash
LEO_V35=~/.leo/bin/leo-3.5 LEO_V4=$(which leo) \
  ./tmp/bug-hunts/leo-v35-to-v4-upgrade/run-probe.sh
```

### Artifacts

- v1 source (v3.5): `tmp/bug-hunts/leo-v35-to-v4-upgrade/programs-v1/counter_prog/main.leo`
- v2 source (v4): `tmp/bug-hunts/leo-v35-to-v4-upgrade/programs-v2/counter_prog/main.leo`
- Active source: `tmp/bug-hunts/leo-v35-to-v4-upgrade/programs/counter_prog/main.leo` (reset from v1 at probe start, then overwritten by v2 before upgrade)
- Compiled (v4): `tmp/bug-hunts/leo-v35-to-v4-upgrade/artifacts/counter_prog.aleo/main.aleo`
- ABI (v4): `tmp/bug-hunts/leo-v35-to-v4-upgrade/artifacts/counter_prog.aleo/abi.json`
- Deploy manifest: `tmp/bug-hunts/leo-v35-to-v4-upgrade/artifacts/counter_prog.aleo/deploy.json`
- Typechain: `tmp/bug-hunts/leo-v35-to-v4-upgrade/typechain/CounterProg.ts`
- Tests: `tmp/bug-hunts/leo-v35-to-v4-upgrade/test/post-upgrade.test.ts`
- LionDen upgrade script: `tmp/bug-hunts/leo-v35-to-v4-upgrade/scripts/upgrade-lionden.ts`
- Direct SDK follow-up script: `tmp/bug-hunts/leo-v35-to-v4-upgrade/scripts/upgrade-direct.ts`

---

## Probe 4: leo-v35-cross-program

_Pending_

---

## Probe 5: leo-v35-library

_Pending_
