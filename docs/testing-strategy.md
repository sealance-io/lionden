# Testing Strategy

When to read this: use this file for the repo-wide test taxonomy, the current CI lanes and root test scripts, test-layout and ownership conventions, recommended coverage allocation, and the testing backlog. Use [`testing.md`](testing.md) for the `@lionden/testing` API and the `lionden test` task.

## At A Glance

Current lanes ([CI Lanes](#ci-lanes) has the detail; [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) is the source of truth):

- **Every code PR:** `npm test`, which runs the `unit` (Tier 1) and `contract` (Tier 2) Vitest projects.
- **PRs that change build or example inputs:** four smoke lanes without proofs: core examples, Aleo ports, the `legacy-v43` fixture, and `leo-samples`.
- **Daily:** `npm run test:smoke:leo-samples:prove`, the only scheduled proof lane.
- **Local only:** every other smoke, proof, coverage, and deploy-backend script. Every devnode lane binds a fixed TCP port, so run them one at a time.

What each section is:

- **Current setup:** [Ground Truth Today](#ground-truth-today), [Concrete Repo Layout](#concrete-repo-layout), [Contract Test Harnesses](#contract-test-harnesses), [CI Lanes](#ci-lanes), [Current Script Surface](#current-script-surface), and [Vitest Project Configuration](#vitest-project-configuration).
- **Policy:** [Testing Principles](#testing-principles), the [Test Taxonomy](#test-taxonomy) tiers, and [Decision Rules For Future Changes](#decision-rules-for-future-changes).
- **Recommendations:** [Coverage Allocation By Subsystem](#coverage-allocation-by-subsystem), [How To Test Leo Program Behavior](#how-to-test-leo-program-behavior), the devnode, fixture, and example strategies, and the coverage, diagnostics, and flake policies.
- **Backlog:** [Remaining Near-Term Backlog](#remaining-near-term-backlog).

## Why This Doc Exists

LionDen is hard to test with a single approach:

- much of the repo is deterministic transformation logic and should be tested without a network
- some important behavior lives at package boundaries and is only visible when multiple packages cooperate
- end-to-end coverage is expensive because realistic flows involve Leo compilation, devnode lifecycle, network state, and sometimes proof generation

The current repo already reflects this tension:

- root Vitest coverage is package-oriented
- `@lionden/plugin-test` runs project-local suites under `test/`
- `@lionden/testing` creates an LRE, optionally starts a devnode, and exposes deploy/execute helpers
- default isolation is a fresh managed devnode per `setup()` context (normally one per test file); `loadFixture()` caches setup results such as deployments but does not restore chain state, and `setup({ snapshotReset: true })` only enables `ctx.snapshot()` / `ctx.restore()` on the standalone `aleo-devnode` backend — restore is explicit, with no automatic per-test reset (see [`testing.md` § Snapshot-based fast reset](testing.md#snapshot-based-fast-reset))
- each workspace package has at least some package-level coverage, and the root Vitest config already splits unit and contract projects

This strategy sets out a testing model that accepts those constraints and organizes the suite accordingly.

## Ground Truth Today

The policy and recommendations below build on the current implementation:

- package tests run through the root Vitest config in [`vitest.config.ts`](../vitest.config.ts)
- root test scripts are defined in [`package.json`](../package.json); [Current Script Surface](#current-script-surface) maps them to tasks
- project tests run through the `test` task in [`packages/plugin-test/src/index.ts`](../packages/plugin-test/src/index.ts)
- the programmatic test runner discovers `test/**/*.test.ts` under the project root in [`packages/plugin-test/src/test-runner.ts`](../packages/plugin-test/src/test-runner.ts)
- `setup()` creates or reuses an LRE, optionally starts a devnode, connects to a network, and returns deploy/execute helpers in [`packages/testing/src/test-context.ts`](../packages/testing/src/test-context.ts)
- fixture caching exists in [`packages/testing/src/fixtures.ts`](../packages/testing/src/fixtures.ts)
- the network layer already supports `mode: "local" | "onchain"` execution in [`packages/network/src/types.ts`](../packages/network/src/types.ts) and [`packages/network/src/connection.ts`](../packages/network/src/connection.ts)
- repo-private test fakes, temp-project builders, and shared mocks live in [`packages/test-internals`](../packages/test-internals)

## Strategy Goals

- keep the default feedback loop fast enough for normal development
- move the bulk of coverage into deterministic tests instead of expensive devnode suites
- make package-boundary behavior testable without requiring a full end-to-end environment
- keep a small number of real workflow smoke tests that prove the stack still works
- isolate proof-generation testing into a separate lane
- improve failure diagnosis so expensive tests are worth running

## Non-Goals

- achieving a single coverage number that mixes cheap and expensive tests into one target
- making every behavior run through a real devnode in CI
- pretending the default per-file devnode isolation is equivalent to snapshot/revert semantics; snapshot/restore is an explicit opt-in, not an automatic reset
- replacing Vitest with a custom LionDen-specific test runner

## Testing Principles

1. Prefer the cheapest test that can reliably detect the regression.
2. Test pure transformations as pure transformations.
3. Test package boundaries with stable repo-owned fakes rather than ad hoc mocks.
4. Reserve real devnode tests for network state, deployment semantics, and cross-package workflow checks.
5. Treat proof generation as a special compatibility lane, not the default development loop.
6. Keep example-project smoke tests small and intentional.

## Test Taxonomy

Current policy: LionDen uses four explicit test tiers. Tier 1 and Tier 2 are the `unit` and `contract` Vitest projects, Tier 3 is the example smoke lanes, and Tier 4 covers the `--prove` runs and the deploy-backend parity and scale harnesses.

### Tier 1: Fast Deterministic Tests

Purpose:
- validate pure logic, normalization, parsing, planning, and code generation

Characteristics:
- no devnode
- no real Leo process
- no network
- no sleeping or polling
- sub-second to low-second runtime per package

Primary targets:
- `packages/config`
- `packages/core`
- most of `packages/leo-compiler`
- deployment state parsing in `packages/plugin-deploy`
- scaffolder template rendering in `packages/create-lionden`

Recommended techniques:
- table-driven tests
- golden-file tests for generated output
- property-based tests for parsers and normalization code
- regression fixtures for edge-case Leo layouts and ABI shapes

### Tier 2: Contract Tests

Purpose:
- validate behavior at package boundaries without requiring a full project smoke test

A Tier 2 test **crosses package boundaries** — it composes real code from multiple LionDen packages. Tests within a single package that use fakes for external processes (e.g., a stubbed Leo CLI runner inside `packages/leo-compiler`) remain Tier 1.

Characteristics:
- compose 2-4 real LionDen packages together
- use repo-owned fakes for external systems such as Leo CLI, SDK calls, filesystem workspaces, or process spawning
- verify contracts at the seams where unit tests are too mocked and end-to-end tests are too expensive

Primary targets:
- `core` + `plugin-*` task registration and override behavior
- `plugin-test` + Vitest runner configuration
- `testing` + `network` interactions when devnode lifecycle is stubbed
- `leo-compiler` orchestration around materialization, cache decisions, and command planning
- `plugin-deploy` interactions with compiler output, deployment state rules, and network calls

Recommended techniques:
- fake `NetworkConnection` and `NetworkManager` implementations
- fake Leo command runner with recorded invocations
- temp project builders with controlled fixture trees
- snapshotting normalized outputs and planned command arguments

### Tier 3: Workflow Smoke Tests

Purpose:
- prove that a real LionDen project can compile, deploy, execute, and assert state in a realistic environment

Characteristics:
- real example project
- real `lionden test` path
- real devnode lifecycle
- minimal number of assertions
- optimized for confidence, not breadth

Primary targets:
- `examples/hello-world`
- `examples/token`
- `examples/multi-program`
- `examples/nft-registry`
- `examples/async-escrow`
- `examples/renamed_dynamic_records`

Expected scope:
- one smoke suite per example that proves the happy path
- one or two targeted negative-path suites only where the workflow contract is especially critical

### Tier 4: Proof And Compatibility Tests

Purpose:
- validate the slowest and most brittle compatibility path separately from normal PR feedback

Characteristics:
- real proof generation
- longer timeouts
- narrower scope
- nightly, release, or manually triggered

Primary targets:
- one deploy + execute proof path on devnode
- constructor/deploy compatibility paths that depend on exact network behavior
- SDK compatibility checks that are known to be sensitive

## Concrete Repo Layout

This section describes the current layout and its conventions. The structure should stay mostly intact: the aim is to clarify intent rather than move everything.

### Keep

- `packages/*/src/**/*.test.ts` for fast deterministic tests
- `examples/*/test/**/*.test.ts` for project workflow smoke tests

### Contract-test naming

- `*.contract.test.ts` naming convention for contract tests that cross package boundaries, colocated in the package that owns the integration surface (e.g., `packages/cli/src/cli-dispatch.contract.test.ts`)
- Vitest named projects select contract tests by filename pattern rather than directory, avoiding a new top-level `tests/` tree with its own `tsconfig.json` and import-path complexity

### Keep `packages/test-internals/` (Private)

Keep repo-owned test infrastructure in the private (`"private": true`, not published) `@lionden/test-internals` package. It holds network fakes, temp-project and contract-LRE builders, shared config and connection mocks, the Leo CLI capture corpus (verbatim `leo deploy` / `leo upgrade` recordings), and the shared SDK egress policy for fake and mock connections. [`packages/test-internals/src/index.ts`](../packages/test-internals/src/index.ts) is the exported surface.

This keeps `@lionden/testing` focused on the user-facing test context, assertions, and fixtures. Internal test fakes should not ship in a published package or couple repo-internal infrastructure to its release cycle.

Potential future additions still belong here when needed, for example fake Leo process runners, example-project builders, and diagnostics helpers for failed smoke runs.

## Coverage Allocation By Subsystem

Recommendation: the tiers each package should be covered in, what those tests should focus on, and the expected split. Package names are directories under `packages/`. Use the table to decide where a new test belongs.

| Package | Tiers | Coverage focus | Expectation |
| --- | --- | --- | --- |
| `config` | 1 | config variables, validation rules, merge behavior, environment-driven resolution | near-complete deterministic coverage |
| `core` | 1, 2 | plugin order, hook dispatch semantics, config lifecycle, task override and dispatch behavior, LRE creation boundaries | pure behavior stays in Tier 1; cross-plugin and task-registry behavior gets contract tests |
| `cli` | 1, 2, 3 | config discovery, argument parsing, help output, dispatch into the task registry | argument parsing and help output are pure Tier 1 targets; use contract tests for config discovery and dispatch; avoid broad subprocess-heavy suites; rely on smoke tests for one real CLI workflow per example. Existing package-level coverage includes config discovery, task dispatch, and CLI/LRE contract behavior |
| `leo-compiler` | 1, 2 | source discovery, dependency resolution, package materialization, ABI parsing, code generation, cache invalidation decisions, Leo command planning and output handling | should carry a large share of the repo's total coverage; use golden fixtures heavily; keep golden ABI fixtures decoupled from live example artifacts by copying stable fixture ABIs into `packages/leo-compiler/src/__fixtures__/`, so compiler tests do not break when an unrelated example is recompiled |
| `network` | 1, 2, 4 | connection lifecycle, execution-mode branching, endpoint selection, confirmation polling, SDK adapter behavior, devnode manager process handling | local branching and request construction should be deterministic; only a narrow set of tests should require real devnode or proof paths |
| `testing` | 1, 2, 3 | LRE factory behavior, fixture caching, test context lifecycle, managed devnode startup/teardown, assertions | package tests cover the helper semantics; smoke tests prove the helpers work in a real project |
| `plugin-leo` | 1, 2 | task registration for `compile` and `clean`, task argument normalization, orchestration between task args and the compiler pipeline | pure argument handling and task registration belong in Tier 1; orchestration with `leo-compiler` belongs in Tier 2. Existing package-level coverage includes task registration, routing, and compile-task orchestration |
| `plugin-deploy` | 1, 2, 3 | deployment state read/write, deploy target resolution, task-to-network orchestration | substantial Tier 1 coverage of deployment state I/O exists; deploy orchestration and network interactions belong in Tier 2; one smoke path through example deploy belongs in Tier 3 |
| `plugin-network` | 2 | task registration, network manager injection via `extendLre()` | thin orchestration plugin, covered primarily through boundary tests |
| `plugin-test` | 1, 2 | task registration and argument handling, Vitest runner configuration, compile/test task interaction | argument handling and config validation belong in Tier 1; runner integration and hook dispatch belong in Tier 2 |
| `create-lionden` | 1, 3 | template rendering, file tree creation, example script and config correctness | deterministic scaffolding tests plus one smoke path that verifies a scaffolded project actually works |

## How To Test Leo Program Behavior

LionDen should split Leo program tests into two categories.

### Semantic Transition Tests

Use `mode: "local"` whenever the test is trying to validate:

- transition outputs
- argument normalization
- happy-path program semantics
- generated wrapper behavior that does not depend on chain state

Rationale:
- local execution already exists in the network layer
- these tests are much cheaper than on-chain execution
- they remove devnode state management from cases that do not need it

### Chain-State Tests

Use `mode: "onchain"` only when the test needs:

- mapping reads and writes
- block advancement
- balance changes
- confirmations
- deploy semantics
- upgrade behavior
- fee or proof-specific behavior

Rationale:
- these are the behaviors that justify real network cost

## Devnode Strategy

LionDen should not try to turn devnode into the default test primitive for every suite.

Recommended policy:

- one managed devnode per smoke suite file, not per individual test
- no cross-file shared global devnode in the default lane
- fixture-based reuse inside a suite for deploy-heavy setup
- local execution for semantic assertions whenever possible
- explicit proof suites for slow paths

This aligns with the current default: test isolation comes from a fresh managed devnode lifecycle plus fixture reuse. `setup({ snapshotReset: true })` is an opt-in that exposes `ctx.snapshot()` / `ctx.restore()` on the standalone `aleo-devnode` backend; it does not reset state between tests by itself, so a suite that wants per-test isolation calls `ctx.restore()` explicitly, typically in `beforeEach`.

## Fixture Strategy

The existing `loadFixture()` helper should become the standard setup primitive for expensive state preparation.

Recommended usage:

- cache deployments per suite
- return structured handles such as `{ ctx, deployment, accounts }`
- make fixtures idempotent and narrowly scoped
- avoid implicit global mutable state outside the fixture cache

Recommended additions (none of these exist yet):

- `loadProjectFixture()` for temp project creation
- `loadDeploymentFixture()` for compile + deploy setup
- `clearTestArtifacts()` for diagnostics cleanup

## Contract Test Harnesses

The repo provides initial harnesses for seams that are hard to cover with isolated unit tests. These harnesses live in `packages/test-internals/`, not in the published `@lionden/testing` package.

### Fake Network Harness

Currently provided:

- fake connection object implementing `NetworkConnection`
- controllable execute responses
- controllable mapping state
- controllable confirmation and block-height behavior
- call recording for assertions

Use for:

- deploy orchestration tests
- test context behavior
- wrapper and assertion helpers

### Fake Leo Harness

Currently provided, for `leo deploy` / `leo upgrade`: `FakeLeoCli` in `packages/plugin-deploy/src/deploy-backend/leo/fake-leo-cli.ts`, a fake process runner swapped in as the backend's injected `LeoRunner`. It lives in `plugin-deploy` rather than `test-internals` because `test-internals` cannot depend on `plugin-deploy` — the dependency runs the other way — and `LeoRunner` is defined there.

Use it for deploy-backend argv, environment, and outcome-parsing tests, and for the Leo path's orchestration contract test. What it records, the files it writes, and how it redacts output are in [`deploy-backends.md` § Testing](deploy-backends.md#testing).

Still a future addition: an equivalent runner fake for `leo build` and `leo devnode start`, for compiler orchestration and devnode command construction.

### Temp Project Builder

Currently provided:

- builder for config file, `programs/`, `scripts/`, and `test/`
- fixture helpers for nested Leo imports and multi-program workspaces
- stable absolute paths for CLI and LRE discovery tests

Use for:

- config discovery
- compiler project graph scenarios
- plugin-test integration

## Example Project Strategy

Examples should be treated as smoke-test fixtures, not as the place where all detailed behavioral testing lives.

### `examples/hello-world`

Role:
- minimal compile/deploy/execute smoke test

Keep:
- one fast happy-path suite

### `examples/token`

Role:
- stateful workflow smoke test

Keep:
- on-chain mapping and block assertions

Change:
- move most semantic transition checks into local-mode tests

### `examples/multi-program`

Role:
- cross-program interaction and dependency graph smoke test

Keep:
- on-chain cross-program calls and state assertions

Change:
- move semantic transition checks into local-mode tests where possible

### `examples/nft-registry`

Role:
- struct/record codegen and test pattern smoke test

Keep:
- `loadFixture()` usage across describe blocks
- local execution mode demonstration

### `examples/async-escrow`

Role:
- typechain bindings usage in tests smoke test

Keep:
- generated TypeScript contract wrapper for all transitions
- escrow state machine lifecycle assertions

### `examples/renamed_dynamic_records`

Role:
- renamed deploy, dynamic-record dispatch, and renamed upgrade smoke test

Keep:
- one focused end-to-end suite proving deploy rename, dynamic-record recovery, and upgrade by runtime id

### Future Examples

Only add a new example when it represents a new workflow contract not covered by existing examples. Do not add examples just to increase raw test count.

## CI Lanes

The repo exposes explicit scripts for each lane. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) is the source of truth for which lanes run on pull requests and which changed paths select them; [`ci-cd/REPOSITORY-SETUP.md` § Workflows at a glance](ci-cd/REPOSITORY-SETUP.md#workflows-at-a-glance) lists every workflow.

### Required On Every Code PR

- `npm test` — the `unit` and `contract` Vitest projects (`test:unit` + `test:contract`) in one run

This is the PR quality gate. CI runs it on every pull request that changes a non-Markdown file (docs-only PRs skip it), so it must stay fast and reliable enough to block on.

### Required When Build Or Example Inputs Change

When a pull request touches package source, examples, scripts, the Leo fixture trees the smoke lanes consume, or build and dependency configuration (the exact path filter is the `detect-changes` job in `ci.yml`), CI also runs four smoke jobs. The **CI Status** rollup fails if any of them fails:

- `npm run test:smoke` — the maintained core examples on Leo 4.4.2
- `npm run test:smoke:aleo-ports` — the larger 4.4.2 ported-example lane
- `npm run test:smoke:legacy-v43` — one intentionally Leo 4.3-only fixture using legacy `self.*` metadata syntax
- `npm run test:smoke:leo-samples` — the adapted `leo-samples` lane, on its own pinned Leo line (see [Current Script Surface](#current-script-surface))

None of the PR smoke jobs passes `--prove`. The core lane should stay small enough to run on normal pull requests; if its runtime becomes too high, split it further.

### Scheduled Lane

- `npm run test:smoke:leo-samples:prove` — runs daily, and on manual dispatch, from [`.github/workflows/leo-samples-nightly.yml`](../.github/workflows/leo-samples-nightly.yml)

### Local On-Demand Lanes

These scripts are not wired into any workflow (a manual dispatch of `ci.yml` runs only the PR lanes above); run them locally when a change needs them:

- `npm run test:smoke:all:prove`
- `npm run test:smoke:all:leo-backend:prove` — core examples plus Aleo ports on the Leo 4.4.x deploy backend, with real proof generation
- `npm run test:deploy-backend-parity` — SDK vs Leo record parity against a real chain
- `npm run test:deploy-backend-scale` — the memory-wall acceptance harness

All four are devnode-backed and bind a fixed TCP port, so they must run one at a time and never alongside another devnode lane. An SDK compatibility lane against the supported toolchain matrix remains optional future work.

### Deploy Backend Lanes

`deploy` and `upgrade` build transactions through a swappable backend ([`deploy-backends.md`](deploy-backends.md)), so the smoke runner takes a `--deploy-backend <sdk|leo>` axis crossing the existing example lanes:

- `npm run test:smoke:leo-backend` — the legacy 4.3 fixture on the Leo CLI backend
- `npm run test:smoke:leo-backend:prove` — the same with real proof generation
- `npm run test:smoke:all:leo-backend:prove` — all current 4.4.x core and Aleo-port examples on the Leo CLI backend, with real proof generation

`--deploy-backend leo` **fails** rather than skipping, before any example compiles, when the `leo` on `PATH` is outside the `4.3.x`/`4.4.x` lines the backend supports, so a green opt-in lane always exercised the backend. Fixtures pinned to an older line, such as `legacy-v43`, still require a matching compiler line in their own `lionden.config.ts`. The `leo-samples` lane deliberately has no such axis: it is pinned to Leo 4.2.0 / consensus V15, which the Leo deploy backend does not support.

The Leo path's own orchestration is covered at Tier 2 by `packages/plugin-deploy/src/leo-deploy-orchestration.contract.test.ts`, which runs in the `contract` project (so in `npm test`) with only the process boundary faked. It asserts the Leo path alone; equivalence between the backends is the parity lane's job.

Equivalence *between* the backends, and the feature's own justification, are Tier 4:

- `npm run test:deploy-backend-parity` (`scripts/verify-deploy-backends.mjs`) — SDK vs Leo parity of the persisted deployment records, plus real-chain `--dry-run` purity, against a fresh devnode per arm
- `npm run test:deploy-backend-scale` (`scripts/verify-deploy-scale.mjs`) — the memory-wall acceptance harness: a chain-valid deployment that succeeds under Leo and not under the SDK. It always runs with `--prove`, and the SDK arm is expected to hang until it is killed at a 15-minute bound, so budget for a long run.

Both apply the same `leo`-on-`PATH` line check as the smoke runner, and the compiled project's own Leo preflight still applies on top: parity compiles the `hello-world` and `multi-program` examples (pinned to Leo 4.4.2, so a 4.4.x `leo`), while the scale fixture pins Leo 4.3.2 (a 4.3.x `leo`).

None of the five backend scripts above is wired into a workflow. Each is devnode-backed and binds a fixed TCP port, so run them one at a time and never alongside another devnode lane.

How each of these works — the worker bridging of the smoke axis, the parity cases and record normalization, the scale fixture's shape, its assertions, and its measurements — is in [`deploy-backends.md` § Testing](deploy-backends.md#testing).

## Current Script Surface

[`package.json`](../package.json) defines every root script. This table maps common tasks to them. Run `npm run build` before the Vitest and smoke commands, because `@lionden/*` imports resolve to each package's built `dist/` output.

| Task | Command | Notes |
| --- | --- | --- |
| Unit and contract tests (the PR gate) | `npm test` | Runs both Vitest projects in one run |
| One Vitest project | `npm run test:unit` or `npm run test:contract` | Selects a named project (see [Vitest Project Configuration](#vitest-project-configuration)) |
| Full Vitest run with minimal output | `npm run test:agent` | Vitest's `agent` reporter keeps passing-test output short |
| Watch mode | `npm run test:watch` | |
| Package source coverage | `npm run test:coverage` | Opt-in, so default local and CI runs stay fast and produce no coverage artifacts |
| Core example smoke | `npm run test:smoke` | The normal local smoke command |
| Other example groups | `npm run test:smoke:aleo-ports`, `npm run test:smoke:legacy-v43`, `npm run test:smoke:all` | `all` runs the core examples plus the Aleo ports; it does not include `legacy-v43` |
| Adapted `leo-samples` lane | `npm run test:smoke:leo-samples` | Separate runner on its own pinned Leo line (below) |
| Smoke with real proofs | `npm run test:smoke:prove` | `:prove` scripts exist for core, `aleo-ports`, `all`, and `leo-samples`; `legacy-v43` has one only on the Leo deploy backend (`test:smoke:leo-backend:prove`) |
| Smoke coverage report | `npm run test:smoke:coverage` | `:coverage` and `:prove:coverage` scripts exist for the same four groups |
| Leo CLI deploy backend | `npm run test:smoke:leo-backend` | The other backend scripts are in [Deploy Backend Lanes](#deploy-backend-lanes) |
| Release tooling regressions | `npm run test:release-scripts`, `npm run test:version-packages` | CI runs both in the lint job on every PR; see [`ci-cd/RELEASING.md`](ci-cd/RELEASING.md) |

Every smoke, proof, and deploy-backend script starts devnodes on a fixed TCP port. Run one at a time, and never alongside another devnode lane. For a group and flag combination with no script, pass the flags to the runner directly, for example `node scripts/run-smoke-examples.mjs --prove legacy-v43`.

Runner behavior:

- Smoke tests delegate to `scripts/run-smoke-examples.mjs`, which invokes the CLI with `--config` for each example because the CLI discovers config from `process.cwd()` and the examples live outside the repo root's config scope. For each example or fixture, the runner compiles, runs `tsc -p <project>/tsconfig.json --noEmit`, then runs `lionden test`; pass `--no-typecheck` to skip the TypeScript check during local debugging.
- The runner keeps the curated core example list explicit, including `examples/renamed_dynamic_records`, and all core examples target Leo 4.4.2. It discovers `examples/aleo-ports/*/lionden.config.ts` dynamically for the broader 4.4.2 Aleo-ports lane. The `legacy-v43` group selects only `test/fixtures/leo-versions/v43-legacy-context`, proving legacy `self.*` syntax with a matching Leo 4.3 binary.
- The `test:smoke:leo-samples` lane (`scripts/run-leo-samples.mjs`) is intentionally decoupled and stays pinned to Leo 4.2.0 / consensus V15; it adapts the pinned `leo-samples` submodule into generated LionDen projects, runs the hermetic in-process proof + compile/codegen suites, typechecks each generated project that has an on-chain suite, then runs those suites sequentially through `lionden test`; pass `--no-onchain` for the no-devnode compile/typecheck path or `--no-typecheck` for local debugging.
- Pass `--prove` to a smoke runner, or use a `:prove` script, to forward `lionden test --prove --timeout 900000` into every selected example or generated `leo-samples` project.
- Pass `--deploy-backend <sdk|leo>` to `run-smoke-examples.mjs`, or use a `leo-backend` script, to select the deploy-transaction backend for every selected example. See the deploy backend lanes above.
- Pass `--coverage` to a smoke runner, or use a `:coverage` script, to forward `lionden test --coverage` into each selected example or generated `leo-samples` project. Each project emits a Vitest blob report under `.vitest/smoke-coverage/<lane>/blobs/` and temporary per-run coverage under `.vitest/smoke-coverage/<lane>/runs/`; after every selected project passes, the runner merges the blobs from the repo root into `coverage/smoke/<lane>/`. The merge is skipped when any project fails, preserving the smoke runner's fail-fast behavior.

Smoke lanes intentionally typecheck generated `typechain/**/*.ts` alongside example tests so wrapper API drift is caught before runtime-only tests can mask it.

## Vitest Project Configuration

The root Vitest config already uses named projects.

Current projects ([`vitest.config.ts`](../vitest.config.ts) holds the exact globs):

- `unit` — selects `packages/*/src/**/*.test.ts` excluding `*.contract.test.ts`, plus two Leo-free groups outside `packages/`: the `leo-samples` adapter test and the smoke-runner helper tests under `scripts/lib/`
- `contract` — selects `packages/*/src/**/*.contract.test.ts`

Do not force smoke tests into the root Vitest project if they naturally belong to project-local `lionden test` runs.

## Coverage Policy

Coverage should be measured separately by lane.

Current state: coverage is opt-in and reporting-only in every lane, and no thresholds are enforced. The root coverage scope in the third item below is already configured in [`vitest.config.ts`](../vitest.config.ts), and smoke coverage already works as the fourth item describes.

Recommended policy:

- enforce coverage thresholds only for Tier 1 and selected Tier 2 suites
- do not block on coverage percentages for smoke or proof lanes
- keep root Vitest coverage scoped to package source under `packages/*/src/**/*.ts`, excluding test files, `packages/test-internals`, and checked-in `__goldens__` fixtures
- keep smoke coverage opt-in and reporting-only; use it to see which package implementation paths the real examples drive
- track smoke lane count, duration, and flake rate instead

Suggested initial targets:

- deterministic lines/branches threshold for `packages/config`, `packages/core`, and `packages/leo-compiler`
- no global monorepo threshold; set thresholds per lane now that lanes are separate Vitest projects

## Failure Diagnostics

Expensive failures must produce useful artifacts. This is a recommendation: the smoke runners do not preserve failure artifacts yet (see [Remaining Near-Term Backlog](#remaining-near-term-backlog)). Today nothing is preserved beyond what error messages carry; for example, a managed devnode includes its buffered log tail in health-check timeout and unexpected-exit errors (see [`network.md` § Devnode log mode](network.md#devnode-log-mode)).

When a smoke or proof suite fails, preserve:

- devnode stdout/stderr
- Leo command stdout/stderr
- generated artifacts paths
- transaction ids
- confirmation polling context
- project root used by the test runner

This should be handled by repo-level helpers, not reimplemented per suite.

## Flake Management

The repo should explicitly track flakiness rather than treating it as unavoidable.

Recommended policy:

- no retries in deterministic lanes
- limited retries only for smoke and proof lanes, with retry counts reported
- quarantine only with a tracked follow-up issue
- record and review top flaky tests monthly

## Remaining Near-Term Backlog

This is the single list of open testing work. Keep it small and high leverage.

1. Continue converting the `token` and `multi-program` example tests to use `mode: "local"` for semantic transition checks, and cut other unnecessary devnode work in example projects. This needs no new infrastructure and saves CI time immediately.
2. Expand contract tests only at high-value boundaries that are still mostly covered through smoke tests.
3. Keep moving duplicated ad hoc mocks into `packages/test-internals/` when nearby tests change.
4. Expand golden coverage for compiler output, package materialization, and TypeScript codegen. Add more stable fixture ABIs under `packages/leo-compiler/src/__fixtures__/`, plus edge-case fixtures for nested imports and multi-program graphs.
5. Add a scheduled `--prove` smoke path for the core examples (today only the `leo-samples` lane has a nightly proof run).
6. Add failure-artifact capture for smoke and future proof lanes (see [Failure Diagnostics](#failure-diagnostics)).
7. Establish runtime and flake budgets for the smoke and proof lanes (see [Coverage Policy](#coverage-policy) and [Flake Management](#flake-management)).

## Success Criteria

The strategy is working when:

- normal PR feedback comes primarily from deterministic and contract lanes
- smoke runtime stays bounded and failures are diagnosable
- proof tests run separately and do not block day-to-day iteration
- example suites prove workflow health without becoming the main source of behavioral coverage
- new package features come with a clear answer to which tier they belong in

## Decision Rules For Future Changes

When adding a new feature, ask:

1. What is the cheapest lane that can detect a regression here?
2. Is this logic pure, boundary-oriented, or workflow-oriented?
3. Does it require real chain state, or only semantic execution?
4. If it needs a fake, should the fake become a shared repo harness instead of a test-local mock?
5. If it needs a smoke test, what existing smoke can be replaced or simplified so the lane stays small?

If those questions do not have a clear answer, the test design is probably still too broad.
