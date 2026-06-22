# Codegen Name-Collision Bug-Hunt Peer Review

Date: 2026-06-22

Scope: peer-review the consolidated bug-hunt report against the live LionDen checkout, saved probe artifacts under `tmp/bug-hunts/`, and relevant codegen/plugin-leo source. This is an inspection artifact only; no implementation changes were made as part of this review.

## Verdict

The bug-hunt report is directionally sound, but the current checkout is not in the clean state described by the report. The live tree contains tracked in-progress fixes/tests for P4 and P5; those focused codegen tests now pass, while P6 and P7 remain reproducible and unfixed.

High-confidence conclusions:

- The headline `resolveExternalInfos` collision fix is supported by the saved P1-P3 generated artifacts and fresh `tsc --noEmit` checks.
- P6 fixed `BaseContract` import collisions and P7 contract-class member collisions are still real and reproducible from the saved generated bindings.
- P4 program-id-to-class-name collisions are a real class of bug and the current dirty checkout contains a fail-fast implementation with focused unit coverage, but the saved P4 generated artifact is no longer present, so the overwrite failure cannot be independently re-run from disk without regenerating.
- P5 dynamic-record helper versus external-record binding appears fixed in the current dirty checkout and current saved artifact; the originally reported failure is not reproducible from the current on-disk P5 artifact.

Practical readiness call: P4/P5 now have plausible tracked fixes plus focused passing tests, but the consolidated collision work is not complete until P6/P7 are addressed or explicitly split out. Do not claim the working tree is clean.

## Checkout State

The report says the working tree is clean except for pre-existing untracked `test/` and gitignored `tmp/`. The live checkout did not match that:

```text
 M packages/leo-compiler/src/codegen/typescript-generator.test.ts
 M packages/leo-compiler/src/codegen/typescript-generator.golden.test.ts
 M packages/leo-compiler/src/codegen/typescript-generator.ts
 M packages/leo-compiler/src/index.ts
 M packages/plugin-leo/src/index.ts
?? test/
```

`git diff --stat` showed:

```text
 .../codegen/typescript-generator.golden.test.ts    | 88 +++++++++++++++++++++
 .../src/codegen/typescript-generator.test.ts       | 72 ++++++++++++++++-
 .../src/codegen/typescript-generator.ts            | 90 +++++++++++++++++++---
 packages/leo-compiler/src/index.ts                 |  2 +
 packages/plugin-leo/src/index.ts                   | 15 ++--
 5 files changed, 248 insertions(+), 19 deletions(-)
```

Those tracked edits appear to implement parts of P4 and P5:

- `generateBindings()` now resolves dynamic-record helpers before creating the generation context and reserves helper names for external aliases.
- `resolveExternalInfos()` and `resolveInputNames()` now accept `reservedHelperNames`.
- `programIdToClassName()` is exported from `@lionden/leo-compiler`.
- `assertTypechainModuleNamesUnique()` was added and exported, using case-insensitive file-stem comparison.
- `@lionden/plugin-leo` now calls `assertTypechainModuleNamesUnique()` before writing `BaseContract.ts`, per-program modules, and `index.ts`.
- New unit tests cover duplicate stems, trailing underscores, `base_contract.aleo`, `index.aleo`, case-only file-stem collisions, and non-over-reservation of `record_output_matcher.aleo`.
- A golden/codegen test covers the P5 dynamic-record helper collision and verifies the external alias bumps to `GoldToken_Token_`.

I treated these as pre-existing user/peer changes and did not revert or edit them.

## Evidence Reviewed

Source and docs:

- `README.md` for current repo/source-of-truth expectations.
- `docs/compiler.md` for the compile/codegen flow and generated binding contract.
- `packages/leo-compiler/src/codegen/typescript-generator.ts`.
- `packages/leo-compiler/src/codegen/typescript-generator.test.ts`.
- `packages/leo-compiler/src/codegen/typescript-generator.golden.test.ts`.
- `packages/leo-compiler/src/index.ts`.
- `packages/plugin-leo/src/index.ts`.

Probe artifacts:

- `tmp/bug-hunts/p1-headline`
- `tmp/bug-hunts/p2-wideninput`
- `tmp/bug-hunts/p3-modulepath`
- `tmp/bug-hunts/p4-overwrite`
- `tmp/bug-hunts/p5-helper-dup`
- `tmp/bug-hunts/p6-fixed-imports`
- `tmp/bug-hunts/p6b-rom`
- `tmp/bug-hunts/p6c-basecontract`
- `tmp/bug-hunts/p7-members`

Fresh checks run during this review:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p1-headline/tsconfig.json --noEmit --pretty false
./node_modules/.bin/tsc -p tmp/bug-hunts/p2-wideninput/tsconfig.json --noEmit --pretty false
./node_modules/.bin/tsc -p tmp/bug-hunts/p3-modulepath/tsconfig.json --noEmit --pretty false
./node_modules/.bin/tsc -p tmp/bug-hunts/p4-overwrite/tsconfig.json --noEmit --pretty false
./node_modules/.bin/tsc -p tmp/bug-hunts/p5-helper-dup/tsconfig.json --noEmit --pretty false
./node_modules/.bin/tsc -p tmp/bug-hunts/p6-fixed-imports/tsconfig.json --noEmit --pretty false
./node_modules/.bin/tsc -p tmp/bug-hunts/p6b-rom/tsconfig.json --noEmit --pretty false
./node_modules/.bin/tsc -p tmp/bug-hunts/p6c-basecontract/tsconfig.json --noEmit --pretty false
./node_modules/.bin/tsc -p tmp/bug-hunts/p7-members/tsconfig.json --noEmit --pretty false
source "$HOME/.nvm/nvm.sh" && nvm use >/dev/null && npx vitest run --reporter=agent packages/leo-compiler/src/codegen/typescript-generator.test.ts packages/leo-compiler/src/codegen/typescript-generator.golden.test.ts
```

Not re-run:

- The real Leo compile step for every probe.
- The P1 devnode runtime round-trip.
- Full repo build or full test suite.

Reason: the checkout is dirty with in-progress codegen fixes, so regenerating all probes would mix original bug evidence with current partial fixes. I only typechecked saved artifacts and inspected the current source/diff.

## Findings By Probe

### P1 - external struct and record aliases versus local declarations

Peer-review status: confirmed from saved artifact and fresh typecheck.

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p1-headline/tsconfig.json --noEmit --pretty false
```

Result: passed.

Generated evidence:

- `tmp/bug-hunts/p1-headline/typechain/Consumer.ts` imports the external struct as `Registry_TokenInfo_`.
- It imports the external record type as `_TokenRegistry_Token_` and emits local exported aliases under `TokenRegistry_Token_`.
- The local interfaces `Registry_TokenInfo` and `TokenRegistry_Token` remain intact.

This supports the report's claim that the alias bumping path works for both external structs and id-only external records. The runtime round-trip claim was not independently rerun in this peer review.

### P2 - `WidenInput` local-name collision

Peer-review status: confirmed from saved artifact and fresh typecheck.

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p2-wideninput/tsconfig.json --noEmit --pretty false
```

Result: passed.

Generated evidence:

- `tmp/bug-hunts/p2-wideninput/typechain/Consumer.ts` imports `type WidenInput as WidenInput_`.
- `Registry_TokenInfoInput` uses `WidenInput_<Registry_TokenInfo>`.
- The local `interface WidenInput` remains intact.

This supports the report's conclusion that the import alias path handles a local `WidenInput` declaration.

### P3 - module-scoped path aliases

Peer-review status: confirmed from saved artifact and fresh typecheck.

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p3-modulepath/tsconfig.json --noEmit --pretty false
```

Result: passed.

Generated evidence:

- `tmp/bug-hunts/p3-modulepath/typechain/Consumer.ts` imports `type Sh_Env as Prov_Sh_Env_`.
- The local `interface Prov_Sh_Env` remains intact.

This supports the report's claim that multi-segment ABI paths produce a stable base name and that the external alias bumps away from a local declaration.

### P4 - non-injective `programIdToClassName` causing file overwrite

Peer-review status: bug class accepted, but current on-disk probe is incomplete.

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p4-overwrite/tsconfig.json --noEmit --pretty false
```

Result:

```text
error TS18003: No inputs were found in config file '/Users/mitzpetel/Workspaces/lionden/tmp/bug-hunts/p4-overwrite/tsconfig.json'. Specified 'include' paths were '["typechain/**/*.ts"]' and 'exclude' paths were '[]'.
```

`find tmp/bug-hunts/p4-overwrite -maxdepth 2 -type f` found only:

```text
tmp/bug-hunts/p4-overwrite/lionden.config.ts
tmp/bug-hunts/p4-overwrite/tsconfig.json
```

So the saved P4 `typechain` output is no longer available for independent re-checking. The underlying claim still matches the source: `programIdToClassName()` splits on `[_\-.]`, capitalizes segments, and joins them, so names such as `foo_bar.aleo` and `foo__bar.aleo` collapse to the same `FooBar` class/file stem.

Current dirty-source status:

- `packages/leo-compiler/src/codegen/typescript-generator.ts` now exports `programIdToClassName()` and adds `assertTypechainModuleNamesUnique()`.
- The guard compares file stems case-insensitively, so it covers both exact class-name collapse (`foo_bar.aleo` plus `foo__bar.aleo`) and platform-sensitive collisions such as `Index.ts` versus `index.ts`.
- `packages/plugin-leo/src/index.ts` now calls that guard before the write loop.
- New unit tests were added in `packages/leo-compiler/src/codegen/typescript-generator.test.ts`.
- The focused codegen tests now pass:

```text
Test Files  2 passed (2)
Tests  134 passed (134)
```

Disposition:

- Keep P4 in the plan/report.
- Preserve or regenerate concrete P4 artifacts before handoff if the goal is a standalone evidence bundle.
- Add a plugin-level test that exercises the actual emit loop, not only the exported compiler helper.

### P5 - dynamic-record helper const versus external record value binding

Peer-review status: current artifact and dirty source show the fix behavior; the original failing state is not reproducible from current saved artifacts.

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p5-helper-dup/tsconfig.json --noEmit --pretty false
```

Result: passed.

Current generated evidence:

- `tmp/bug-hunts/p5-helper-dup/typechain/Consumer.ts` now emits the external record alias/value binding as `GoldToken_Token_`.
- The dynamic-record helper keeps the configured user-facing name `GoldToken_Token`.
- Both coexist in the module and the saved artifact typechecks.

Current dirty-source evidence:

- `generateBindings()` now computes dynamic-record helpers before creating the generation context.
- `resolveExternalInfos()` now reserves `reservedHelperNames` before claiming external aliases.
- `resolveInputNames()` also reserves helper names when claiming input aliases.
- `packages/leo-compiler/src/codegen/typescript-generator.golden.test.ts` now includes a P5-style regression that expects `GoldToken_Token_` for the external binding and preserves `GoldToken_Token` for the helper.

Disposition:

- The recommended P5 fix is the right shape: preserve the user's configured helper name and bump the derived external alias.
- The current tracked change implements this and now has focused golden coverage. It should still be reviewed as a dirty worktree change rather than treated as already landed.

### P6 - fixed `BaseContract` import collisions

Peer-review status: confirmed for the saved local-struct and `record_output_matcher.aleo` artifacts; `base_contract.aleo` saved artifact is missing, but the risk is covered by the same P4/P6 source pattern and by the dirty P4 reserved-file work.

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p6-fixed-imports/tsconfig.json --noEmit --pretty false
```

Result:

```text
tmp/bug-hunts/p6-fixed-imports/typechain/BaseStructHolder.ts(4,10): error TS2440: Import declaration conflicts with local declaration of 'BaseContract'.
tmp/bug-hunts/p6-fixed-imports/typechain/BaseStructHolder.ts(28,5): error TS2353: Object literal may only specify known properties, and 'x' does not exist in type 'BaseContract'.
tmp/bug-hunts/p6-fixed-imports/typechain/LeoFieldHolder.ts(4,448): error TS2440: Import declaration conflicts with local declaration of 'LeoField'.
tmp/bug-hunts/p6-fixed-imports/typechain/LeoFieldHolder.ts(27,3): error TS2322: Type '{ x: number; }' is not assignable to type 'LeoField'.
  Type '{ x: number; }' is not assignable to type 'string'.
```

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p6b-rom/tsconfig.json --noEmit --pretty false
```

Result:

```text
tmp/bug-hunts/p6b-rom/typechain/RecordOutputMatcher.ts(4,24): error TS2440: Import declaration conflicts with local declaration of 'createRecordOutputMatcher'.
tmp/bug-hunts/p6b-rom/typechain/RecordOutputMatcher.ts(4,691): error TS2440: Import declaration conflicts with local declaration of 'RecordOutputMatcher'.
tmp/bug-hunts/p6b-rom/typechain/RecordOutputMatcher.ts(4,696): error TS2395: Individual declarations in merged declaration 'RecordOutputMatcher' must be all exported or all local.
tmp/bug-hunts/p6b-rom/typechain/RecordOutputMatcher.ts(10,14): error TS2395: Individual declarations in merged declaration 'RecordOutputMatcher' must be all exported or all local.
tmp/bug-hunts/p6b-rom/typechain/RecordOutputMatcher.ts(68,75): error TS2707: Generic type 'RecordOutputMatcher<T, S>' requires between 1 and 2 type arguments.
```

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p6c-basecontract/tsconfig.json --noEmit --pretty false
```

Result:

```text
error TS18003: No inputs were found in config file '/Users/mitzpetel/Workspaces/lionden/tmp/bug-hunts/p6c-basecontract/tsconfig.json'. Specified 'include' paths were '["typechain/**/*.ts"]' and 'exclude' paths were '[]'.
```

The current generator still emits a fixed import from `./BaseContract.js` containing value names such as `BaseContract` and `createRecordOutputMatcher` plus many imported type names such as `LeoField` and `RecordOutputMatcher`. There is no general reservation or import-alias map for these names.

Disposition:

- Keep P6 in the plan/report.
- Separate the `base_contract.aleo` file overwrite case from local declaration/import collisions:
  - `base_contract.aleo` belongs with the P4 reserved-file guard.
  - local `LeoField`, local `BaseContract`, and `record_output_matcher.aleo` remain P6 import/declaration collisions.
- Choose an explicit policy before implementing:
  - Fail-fast is smaller and avoids silently changing generated public names.
  - Import aliasing is more user-friendly but broader, because all generator references to fixed BaseContract symbols must route through resolved local import names.

### P7 - contract-class member collisions

Peer-review status: confirmed from saved artifact and fresh typecheck.

Fresh command:

```text
./node_modules/.bin/tsc -p tmp/bug-hunts/p7-members/tsconfig.json --noEmit --pretty false
```

Result included:

```text
tmp/bug-hunts/p7-members/typechain/MemberCollisions.ts(15,12): error TS2416: Property 'connect' in type 'MemberCollisions' is not assignable to the same property in base type 'BaseContract'.
tmp/bug-hunts/p7-members/typechain/MemberCollisions.ts(67,12): error TS2416: Property 'withSigner' in type 'MemberCollisions' is not assignable to the same property in base type 'BaseContract'.
tmp/bug-hunts/p7-members/typechain/MemberCollisions.ts(119,12): error TS2416: Property 'programId' in type 'MemberCollisions' is not assignable to the same property in base type 'BaseContract'.
tmp/bug-hunts/p7-members/typechain/MemberCollisions.ts(275,12): error TS2300: Duplicate identifier 'mappings'.
tmp/bug-hunts/p7-members/typechain/MemberCollisions.ts(275,12): error TS2717: Subsequent property declarations must have the same type.
```

Generated evidence:

- `MemberCollisions.ts` emits transition wrappers as `readonly connect`, `readonly withSigner`, `readonly programId`, and `readonly mappings`.
- The same class also emits the mapping container as `readonly mappings`.
- `connect`, `withSigner`, and `programId` collide with inherited `BaseContract` members.
- `mappings` collides with the generated mapping container.

The source still emits transitions first, then the `mappings` and `storage` containers, with no class-member reservation analogous to mapping/storage property-key collision handling.

Disposition:

- Keep P7 in the plan/report.
- Add a class-member reserved-name pass before emission.
- Prefer fail-fast for the first implementation unless the project intentionally wants to support renamed transition properties. Auto-renaming transition keys is feasible but changes the generated API contract and must be documented/tested.

### S1 - unresolved external reference plus matching local name

Peer-review status: reasonable by source inspection, but lower confidence than the probed cases.

The report says this was not separately probed and is safe by inspection because `collectExternalRefs()` only collects references whose producer ABI is available and contains the referenced type. That is plausible and consistent with the current codegen shape, but it should not be presented at the same confidence level as P1-P7 end-to-end probes.

Disposition:

- It is fine to leave S1 out of immediate fix scope.
- If it remains in the final report, label it "safe by inspection, not separately probed."

### S2 - external serializers versus `create${class}`

Peer-review status: supported by P1's saved artifact and typecheck.

P1 includes both external struct and external record serializers/deserializers and a normal generated factory. The artifact typechecks, so this suspected collision is not currently actionable.

## Current Dirty Fix Review

The in-progress tracked changes look directionally correct for P4/P5, but they are still dirty worktree changes and should be reviewed/landed deliberately:

1. `assertTypechainModuleNamesUnique()` catches duplicate program stems, reserved `BaseContract`, reserved `index`/`Index`, and case-only file-stem collisions.
2. The P4 guard is called from `plugin-leo` before writing generated files, which is the right insertion point for fail-fast behavior.
3. The P5 helper-name reservation is in the right layer and current generated output demonstrates the intended alias bump.
4. The focused tests now pass: `typescript-generator.test.ts` plus `typescript-generator.golden.test.ts` report 134 passing tests.
5. The current tracked changes do not address P6 fixed import collisions except for the `base_contract.aleo` file-stem subset.
6. The current tracked changes do not address P7 class-member collisions.

## Recommended Fix Plan

### P4

Recommended fix:

- Keep the fail-fast module-name guard.
- Keep comparing emitted file stems case-insensitively so the guard is portable across Linux, macOS, and Windows filesystems.
- Keep `BaseContract` reserved.
- Keep the error message explicit that file names are compared case-insensitively.

Cheapest durable tests:

- Compiler unit tests for:
  - `foo_bar.aleo` plus `foo__bar.aleo`.
  - `foobar.aleo` plus `foobar_.aleo`.
  - `base_contract.aleo`.
  - `index.aleo`.
  - case-only collisions such as `ab.aleo` plus `a_b.aleo`.
- A `plugin-leo` emit-loop test proving the guard runs before any generated file overwrite.

### P5

Recommended fix:

- Keep reserving dynamic-record helper names before resolving external aliases and input aliases.
- Preserve the configured helper name and bump the derived external alias/value binding.

Cheapest durable tests:

- Keep the current golden/unit coverage shape:
  - local source record `Receipt`;
  - external record reference `gold_token.aleo::Token`;
  - `codegen.dynamicRecords` helper named `GoldToken_Token`;
  - expected external alias `GoldToken_Token_`;
  - expected module typecheck.

### P6

Recommended fix:

- Split into two subproblems:
  - file-stem collisions handled by P4;
  - fixed BaseContract import-name collisions handled inside generated module naming/import emission.
- Choose either:
  - fail-fast when local declarations or generated class/factory names collide with fixed BaseContract imports; or
  - implement a resolved import-name map and route every generated reference through it.

Cheapest durable tests:

- Local struct named `LeoField`.
- Local struct named `BaseContract`.
- Program id `record_output_matcher.aleo`.
- Program id `base_contract.aleo`, covered under P4.

Expected result should be either clear `CodegenError` or collision-safe emitted TypeScript, depending on the chosen policy.

### P7

Recommended fix:

- Add a reserved class-member guard for:
  - inherited `BaseContract` instance members such as `connect`, `withSigner`, `address`, and `programId`;
  - generated sibling containers `mappings` and `storage`.
- Fail fast with a clear `CodegenError` unless the project explicitly chooses renamed transition properties.

Cheapest durable tests:

- Transition `connect`.
- Transition `withSigner`.
- Transition `programId`.
- Transition `mappings` plus a real mapping.
- Optional latent-only test coverage for `address` and `storage` using synthetic ABI fixtures, since Leo v4 rejects those as source keywords in normal end-to-end probes.

## Risk Notes

- The saved probe directory is not a stable evidence bundle right now: P4 and P6c no longer contain generated `typechain` files.
- The P5 saved artifact reflects the current fix behavior, not the original failure.
- The checkout contains tracked modifications, so any "working tree clean" claim is currently false.
- The current P4/P5 focused tests are green, but full-suite/build status was not checked in this peer review.
- The P6/P7 choice between fail-fast and auto-renaming is an API policy decision, not just a mechanical codegen change.

## Bottom Line

Accept the report's main technical direction, but update its conclusions before using it as final handoff material:

- Mark P1-P3 as verified by saved artifacts and fresh typechecks; keep runtime scope clearly separate.
- Mark P4 as confirmed by source shape and prior report, but note that saved failing artifacts are missing and current validation is from dirty-source unit tests, not regenerated probe artifacts.
- Mark P5 as fixed in the current dirty checkout with focused golden coverage.
- Mark P6 and P7 as still reproducible and still unfixed.
- Do not claim the working tree is clean.
