# leo-samples smoke-test lane

A rigorous smoke lane that maximizes compilation + codegen + generated-binding +
runtime-error + deploy/upgrade coverage at minimum runtime, by adapting the
purpose-built [`sealance-io/leo-samples`](https://github.com/sealance-io/leo-samples)
ABI/runtime-edge fixture set (Leo 4.1.0, consensus V15) into lionden's
source-first projects and driving lionden's **programmatic** APIs in-process on a
no-proving devnode.

It complements the existing `core` / `aleo-ports` lanes, which exercise happy
paths but barely touch the negative/runtime-error surface (across all example
tests: `.failsLocally` ×5, `.rejected` ×1 vs `.accepted` ×74).

## Layout

```
test/fixtures/leo-samples/
  .upstream/                 git submodule → sealance-io/leo-samples (pinned, V15)
  adapter/
    adapt.ts                 adaptSampleGroup(spec) → lionden source-first project on disk
    specs.ts                 per-group specs + expected resolved graph + the exclusion finding
    templates.ts             generated lionden.config.ts / package.json / tsconfig.json
    offline-network-dep.ts   makeOfflineFetchNetworkDep() — serves vendored credits.aleo
    test-support.ts          shared resolved-config builder for in-process compiles
    adapt.test.ts            adapter unit test (runs in the normal unit lane)
    proof.test.ts            0f adapter-proof gate (BLOCKING)
    port-spike.test.ts       0e port-override spike
  network-deps/credits.aleo  vendored V15 credits.aleo snapshot (offline injector source)
  generated/                 adapted projects (GITIGNORED — regenerated idempotently)
  vitest.config.ts           standalone config for the in-process suites (proof, compile-codegen)
```

## Prerequisites

- **Leo 4.1.0** on `PATH`.
- **A working devnode backend** for the on-chain suites. lionden drives two:
  - **standalone `aleo-devnode`** (preferred) — auto-detected when `aleo-devnode`
    is on `PATH` (a `aleo-devnode --version` probe in `resolveDevnodeBackend`).
  - **`leo devnode start`** — the fallback when `aleo-devnode` is absent.

  The on-chain lane needs whichever backend actually boots on the host. On some
  platforms `leo devnode start` panics (e.g. an internal rocksdb error on recent
  macOS), in which case install the standalone `aleo-devnode` binary and put it on
  `PATH` so auto-detect selects it:
  ```bash
  PATH="/path/to/aleo-devnode/dir:$PATH" npm run test:smoke:leo-samples:coverage
  ```
  Backend selection is config-driven and never pinned in the generated projects
  (so a `leo`-only CI keeps working): auto-detect (PATH) is the mechanism. To force
  a backend without editing config, set `provider`/`binary` on the devnode network,
  or export `LIONDEN_DEVNODE_PROVIDER=standalone|leo` (read by `setup()` for the
  auto-started devnode). See `docs/network.md` for the backend model.
- **Initialize the submodule** (CI and contributors):
  ```bash
  git submodule update --init test/fixtures/leo-samples/.upstream
  ```
  The adapter fails with a clear message if it is missing; the adapter/proof
  tests `describe.skipIf` themselves when it is absent so the unit lane never
  breaks on a missing checkout.

## The adapter

Upstream packages are standard Leo CLI packages (`<pkg>/program.json` +
`src/main.leo`). The adapter maps each sample **group** into one lionden project
with N `programs/` subdirs (no `program.json`; lionden regenerates it during
materialization), generates a `lionden.config.ts` from templates, and writes a
`dependency-manifest.json` (the lionden-resolved graph) plus, for upgradability,
out-of-tree `programs.v2/` sources for the in-place upgrade swap.

**Dependency reconciliation.** lionden's import parser is `.aleo`-suffix-only and
ignores `program.json`, so upstream's bare library references (`abi_point_lib::Point`)
are invisible. The adapter rewrites `<lib>::` → `<lib>.aleo::` and prepends
`import <lib>.aleo;` to **program** entry files (matching lionden's own
`math_utils.aleo::min` convention). Library entry files get the rewrite but **no**
import (Leo forbids imports inside a library).

## Findings

### `external_composition` is excluded — library struct **type paths** don't code-gen

Adapting `external_composition` succeeds and produces the correct resolved graph,
but `leo build` fails. lionden's source-first library convention (a `lib.leo`
referenced as `<lib>.aleo::member`) supports library **functions** — proven by
`examples/multi-program`'s `math_utils.aleo::min` — but **not** library **struct
types**:

- A minimal, non-diamond case (`program` consuming `geo_lib.aleo::Point`) panics
  the compiler at code generation:
  `path format cannot be legalized at this point: geo_lib.aleo/Point`.
- The full group fails earlier in the type checker: `the type
  abi_point_lib.aleo::Point is not found in the current scope` (nested modules,
  `ETYC0372017`) and diamond type-identity errors (`expected X, but found X`,
  `ETYC0372117`).

Upstream compiles the same composition only because it references libraries
**bare** (`abi_point_lib::Point`, declared solely as `program.json` metadata),
which lionden cannot detect — so lionden has no way to express an *inlined*
library type. Remediation needs a lionden/Leo change (bare-library detection +
non-`.aleo` materialization, or Leo support for library type paths). Until then
the lane proceeds with the other four projects, and the 0f proof locks this
finding so a future toolchain that fixes it trips the gate for re-evaluation.

### `abi_surface` is compile-only — codegen rejects an unsupported primitive

`abi_surface` compiles and its JSON ABI parses, but codegen cannot emit a usable
TypeScript binding, so no on-chain suite can `import` one. Codegen now rejects
the program **early** — in `assertCodegenSupportedTypes`
(`packages/leo-compiler/src/codegen/typescript-generator.ts`), before any binding
is written:

```
Primitive::Signature is not supported
```

This stricter primitive check **masks** the older const-generic finding: the
struct `Slot::[N]` used to be emitted verbatim as an invalid TS type identifier
(`export interface Slot::[2u32] { ... }`, `serializeSlot::[2u32]`) because
`isValidIdentifier` sanitizes method/field names but **not** struct/interface
*type* names. Codegen never gets that far now — it throws on `Signature` first.

`abi_surface` therefore stays in the **compile/codegen** lane (it still proves
the full ABI breadth: every primitive, nested/array/const-generic structs,
record field modifiers, mappings/storage/vectors, view-fn optionals) but is
marked `compileOnly` and has **no** on-chain suite. The finding is locked by an
assertion in `compile-codegen.test.ts` that expects the
`Primitive::Signature is not supported` rejection; if `Signature` support lands
in codegen, that assertion flips — re-lock the resurfaced `Slot::[N]`
const-generic finding and re-evaluate promoting `abi_surface` to the on-chain
set.

### Port override (0e) is confirmed; multi-devnode parallelism is out of scope

`networks.devnode.socketAddr` is honored end-to-end: a devnode booted with
`socketAddr: "127.0.0.1:3031"` exposes its REST API there and answers a
block-height query (`port-spike.test.ts`). Per-suite-on-its-own-port parallelism
is therefore *feasible*, but **not built** — the remaining blockers are shared
ledger / deploy-cache state isolation and CI port allocation, not code. On-chain
suites stay **sequential** on the shared `127.0.0.1:3030` devnode for now.

### Devnode-backend divergence — V15 record-existence reject needs `--prove`

The on-chain suites run on whichever devnode backend boots (standalone
`aleo-devnode` by auto-detect, else `leo devnode`). One assertion diverges across
backends in the default **no-prove** lane: `dynamic_dispatch`'s `unbacked_dyn`,
which expects the V15 **local record-existence** check to reject a transaction
that outputs a dyn record whose backing static `Receipt` is never produced. That
check is an inclusion/proving-time concern — the no-prove devnode fast-path skips
it. `leo devnode` happens to reject anyway, but the standalone `aleo-devnode`
no-prove path **accepts** the unbacked record (its consensus is compiled-in,
distinct from `leo devnode`'s). Under `--prove`, **both** backends reject it
(verified Jun 2026). The test is therefore gated on `LIONDEN_PROVE` — it runs in
the `--prove` lane (deterministic, backend-independent) and is skipped in the
no-prove lane, so the default lane is green on either backend. All other on-chain
rejects in the lane are **finalizer** rejects, which both backends enforce without
proving.

### lionden gaps surfaced by this lane (both now resolved)

Two upgrade-matrix cells were originally `it.skip` because the lionden API could
not express them. Both are now implemented and the tests run:

1. **Per-upgrade signer override — RESOLVED.** `UpgradeOptions.signerKey`
   (`packages/plugin-deploy`) is a programmatic per-call signer that takes
   precedence over `namedAccounts.admin`. lionden also wires the previously-dead
   `validateAdminSigner` into `runUpgradePreflight`, so an `@admin` upgrade signed
   by a non-admin key is rejected **locally** (fail-fast) before broadcast rather
   than being signed and rejected on-chain by the constructor. The upgradability
   suite drives the wrong-key reject with `ctx.accounts[1].privateKey`, expecting
   `/Only the admin address can upgrade/`.
2. **Pre-broadcast v2-checksum accessor — RESOLVED.** `@lionden/network` exports
   `computeProgramChecksum` (wrapping the SDK's `programChecksum`), and
   `@lionden/plugin-deploy` adds `computeUpgradeChecksum` (reads
   `artifacts/<id>/main.aleo`) + `formatChecksumLiteral` (the `[u8; 32]` literal
   for `approve`). The `@checksum` accept test compiles v2, computes the checksum,
   calls `governance.aleo::approve(<[u8; 32]>)`, then upgrades — the on-chain
   accept confirms the SDK checksum matches the deployment checksum the constructor
   compares (no `leo upgrade --save` fallback needed).

## Curated lane selection (P1)

| Project | Coverage | On-chain? |
| --- | --- | --- |
| `abi_surface` | every primitive, structs (nested/array/const-generic), record field modifiers, mappings/storage/vectors, view-fn optionals → codegen breadth | **compile-only** — see Findings |
| `native_runtime_edges` | overflow/underflow/div-zero/off-chain assert (`LocalTransitionError`), finalizer accept/reject → `OnChainRejectedError`, native `credits.aleo::account` mapping reads (`get_or_use` accept vs bare-`get` reject), storage/vector OOB rejects, a `credits.aleo::transfer_public_as_signer` future wrapper. Diamond import is verified at **compile** time (`compile-codegen`), not at runtime. | yes |
| `dynamic_dispatch` | interfaces, `@(target)`/`_dynamic_call`, dyn records, dynamic mapping reads, V15 accept/**reject** → `.accepted`/`.rejected`, id-only handles | yes |
| `upgradability` | `@noupgrade`/`@custom`/`@admin`/`@checksum`/timelock accept-reject matrix → `upgrade` task. Includes the `@admin` wrong-key reject (per-upgrade `signerKey` + preflight `validateAdminSigner`) and the `@checksum` accept (pre-broadcast checksum + `governance.aleo::approve`). | yes (many deploys) |
| `abi_break` | end-to-end ABI-compat **reject** → `UpgradeCompatibilityError` (`transition_modified`): a `@custom` always-allow upgrade whose v2 changes `version()`'s output type (u8 → u32), so abi-compat preflight is the only gate | yes |
| `lionden_gapfiller` | `TransitionInputError`, every primitive serializer, hashing/crypto, decryption errors | local |
| ~~`external_composition`~~ | **excluded** — see Findings | — |

The on-chain suites map every generated method shape + error class to a concrete
trigger; [`COVERAGE.md`](COVERAGE.md) is the audit matrix (which test hits which,
plus the documented gaps).

## Running

The in-process suites (0f proof + the Phase-2 compile/codegen suite) run via the
standalone config:

```bash
npm run build   # packages resolve to dist; build first
npm exec -- vitest run --config test/fixtures/leo-samples/vitest.config.ts
```

The adapter unit test runs in the normal unit lane (`npm run test:unit`). The
full lane is driven by `scripts/run-leo-samples.mjs` (see the
`test:smoke:leo-samples` npm scripts) and runs, in order:

1. regenerate `generated/**` from the pinned submodule,
2. run the in-process 0f proof + compile/codegen suites,
3. typecheck every generated project that has an on-chain suite with
   `tsc --noEmit -p <project>/tsconfig.json`,
4. run the per-project on-chain suites sequentially, no proving by default.

Use `--no-onchain` for the no-devnode path that still regenerates, compiles,
and typechecks. Use `--no-typecheck` only for local debugging when a generated
binding typecheck is not relevant. Use `--coverage` to merge per-project Vitest
coverage blobs, and `--prove` for the slow proving lane.
