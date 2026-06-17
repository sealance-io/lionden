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

- **Leo 4.1.0** and a devnode backend (`leo devnode`) on `PATH`.
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

### `abi_surface` is compile-only — const-generic struct types break codegen

`abi_surface` compiles and its JSON ABI parses, but its emitted TypeScript
binding is **unusable**. The const-generic struct `Slot::[N]` is emitted verbatim
as a TS type identifier:

```ts
export interface Slot::[2u32] { ... }   // invalid TypeScript
const _x = serializeSlot::[2u32](...);  // invalid TypeScript
```

`::[2u32]` is not a legal identifier, so the whole `AbiSurface.ts` module fails
to parse — neither `tsc` nor esbuild can load it, so no on-chain suite can
`import` it. `isValidIdentifier` in
`packages/leo-compiler/src/codegen/typescript-generator.ts` is applied to
method/field names but **not** to struct/interface *type* names, which pass
through from the ABI path unsanitized.

`abi_surface` therefore stays in the **compile/codegen** lane (it still proves
the full ABI breadth: every primitive, nested/array/const-generic structs,
record field modifiers, mappings/storage/vectors, view-fn optionals) but is
marked `compileOnly` and has **no** on-chain suite. The finding is locked by an
assertion in `compile-codegen.test.ts` (the emitted binding contains the invalid
`Slot::[` token); fixing lionden's codegen (sanitize const-generic struct type
names) trips that assertion and signals the project can be promoted to the
on-chain set.

### Port override (0e) is confirmed; multi-devnode parallelism is out of scope

`networks.devnode.socketAddr` is honored end-to-end: a devnode booted with
`socketAddr: "127.0.0.1:3031"` exposes its REST API there and answers a
block-height query (`port-spike.test.ts`). Per-suite-on-its-own-port parallelism
is therefore *feasible*, but **not built** — the remaining blockers are shared
ledger / deploy-cache state isolation and CI port allocation, not code. On-chain
suites stay **sequential** on the shared `127.0.0.1:3030` devnode for now.

## Curated lane selection (P1)

| Project | Coverage | On-chain? |
| --- | --- | --- |
| `abi_surface` | every primitive, structs (nested/array/const-generic), record field modifiers, mappings/storage/vectors, view-fn optionals → codegen breadth | **compile-only** — see Findings |
| `native_runtime_edges` | overflow/underflow/div-zero/off-chain assert (`LocalTransitionError`), finalizer failures → `OnChainRejectedError`, diamond import, native records/futures | yes |
| `dynamic_dispatch` | interfaces, `@(target)`/`_dynamic_call`, dyn records, dynamic mapping reads, V15 accept/**reject** → `.accepted`/`.rejected`, id-only handles | yes |
| `upgradability` | `@noupgrade`/`@custom`/`@admin`/`@checksum`/timelock accept-reject matrix → `upgrade` task | yes (many deploys) |
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
full lane (adapt → in-process compile/codegen → per-project on-chain suites,
sequential, no proving) is driven by `scripts/run-leo-samples.mjs` (see the
`test:smoke:leo-samples` npm scripts).
