# Testing Strategy

When to read this: use this file for the proposed repo-wide testing strategy, test taxonomy, CI lanes, ownership boundaries, and rollout plan. Use [`testing.md`](testing.md) for the current testing surface that exists in the codebase today.

## Why This Doc Exists

LionDen is hard to test with a single approach:

- much of the repo is deterministic transformation logic and should be tested without a network
- some important behavior lives at package boundaries and is only visible when multiple packages cooperate
- end-to-end coverage is expensive because realistic flows involve Leo compilation, devnode lifecycle, network state, and sometimes proof generation

The current repo already reflects this tension:

- root Vitest coverage is package-oriented
- `@lionden/plugin-test` runs project-local suites under `test/`
- `@lionden/testing` creates an LRE, optionally starts a devnode, and exposes deploy/execute helpers
- fixture reuse exists, but isolation still relies on fresh devnode lifecycle rather than snapshot/revert semantics
- each workspace package has at least some package-level coverage, and the root Vitest config already splits unit and contract projects

This strategy proposes a testing model that accepts those constraints and organizes the suite accordingly.

## Ground Truth Today

The proposal below is based on the current implementation:

- package tests run through the root Vitest config in [`vitest.config.ts`](../vitest.config.ts)
- the root `test` script is currently `vitest run` in [`package.json`](../package.json), with `test:unit`, `test:contract`, `test:agent`, `test:watch`, `test:smoke`, and `test:smoke:aleo-ports` also defined
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
- pretending current devnode isolation is equivalent to snapshot/revert semantics
- replacing Vitest with a custom LionDen-specific test runner

## Testing Principles

1. Prefer the cheapest test that can reliably detect the regression.
2. Test pure transformations as pure transformations.
3. Test package boundaries with stable repo-owned fakes rather than ad hoc mocks.
4. Reserve real devnode tests for network state, deployment semantics, and cross-package workflow checks.
5. Treat proof generation as a special compatibility lane, not the default development loop.
6. Keep example-project smoke tests small and intentional.

## Proposed Test Taxonomy

LionDen should adopt four explicit test tiers.

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
- deployment state parsing and ABI compatibility logic in `packages/plugin-deploy`
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
- `examples/upgradeable-counter`
- `examples/async-escrow`

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

The current structure should stay mostly intact. The proposal is to clarify intent rather than move everything.

### Keep

- `packages/*/src/**/*.test.ts` for fast deterministic tests
- `examples/*/test/**/*.test.ts` for project workflow smoke tests

### Add

- `*.contract.test.ts` naming convention for contract tests that cross package boundaries, colocated in the package that owns the integration surface (e.g., `packages/core/src/task-dispatch.contract.test.ts`)
- Vitest named projects select contract tests by filename pattern rather than directory, avoiding a new top-level `tests/` tree with its own `tsconfig.json` and import-path complexity

### Keep `packages/test-internals/` (Private)

Keep repo-owned test infrastructure in the private (`"private": true`, not published) `@lionden/test-internals` package. It currently contains:

- `fakes/fake-network.ts`
- `builders/temp-project.ts`
- `builders/contract-lre.ts`
- `mock-config.ts`
- `mock-connection.ts`

This keeps `@lionden/testing` focused on the user-facing test context, assertions, and fixtures. Internal test fakes should not ship in a published package or couple repo-internal infrastructure to its release cycle.

Potential future additions still belong here when needed, for example fake Leo process runners, example-project builders, and diagnostics helpers for failed smoke runs.

## Coverage Allocation By Subsystem

### `packages/config`

Primary tier:
- Tier 1

Coverage focus:
- config variables
- validation rules
- merge behavior
- environment-driven resolution

Expectation:
- near-complete deterministic coverage

### `packages/core`

Primary tiers:
- Tier 1
- Tier 2

Coverage focus:
- plugin order
- hook dispatch semantics
- config lifecycle
- task override and dispatch behavior
- LRE creation boundaries

Expectation:
- pure behavior stays in Tier 1
- cross-plugin and task-registry behavior gets contract tests

### `packages/cli`

Primary tiers:
- Tier 1
- Tier 2
- Tier 3

Coverage focus:
- config discovery
- argument parsing
- help output
- dispatch into the task registry

Expectation:
- this package now has package-level coverage for config discovery, task dispatch, and CLI/LRE contract behavior
- argument parsing and help output are pure Tier 1 targets
- avoid broad subprocess-heavy suites
- use contract tests for config discovery and dispatch
- rely on smoke tests for one real CLI workflow per example

### `packages/leo-compiler`

Primary tiers:
- Tier 1
- Tier 2

Coverage focus:
- source discovery
- dependency resolution
- package materialization
- ABI parsing
- code generation
- cache invalidation decisions
- Leo command planning and output handling

Expectation:
- this package should carry a large share of the repo's total coverage
- use golden fixtures heavily
- decouple golden ABI fixtures from live example artifacts — copy stable fixture ABIs into `packages/leo-compiler/src/__fixtures__/` so compiler tests do not break when an unrelated example is recompiled

### `packages/network`

Primary tiers:
- Tier 1
- Tier 2
- Tier 4

Coverage focus:
- connection lifecycle
- execution-mode branching
- endpoint selection
- confirmation polling
- SDK adapter behavior
- devnode manager process handling

Expectation:
- local branching and request construction should be deterministic
- only a narrow set of tests should require real devnode or proof paths

### `packages/testing`

Primary tiers:
- Tier 1
- Tier 2
- Tier 3

Coverage focus:
- LRE factory behavior
- fixture caching
- test context lifecycle
- managed devnode startup/teardown
- assertions

Expectation:
- package tests cover the helper semantics
- smoke tests prove the helpers work in a real project

### `packages/plugin-leo`

Primary tiers:
- Tier 1
- Tier 2

Coverage focus:
- task registration for `compile` and `clean`
- task argument normalization
- orchestration between task args and compiler pipeline

Expectation:
- this package now has package-level coverage for task registration, routing, and compile-task orchestration
- pure argument handling and task registration belong in Tier 1
- orchestration with `leo-compiler` belongs in Tier 2

### `packages/plugin-deploy`

Primary tiers:
- Tier 1
- Tier 2
- Tier 3

Coverage focus:
- constructor annotation parsing
- ABI compatibility checking
- deployment state read/write
- deploy target resolution
- task-to-network orchestration

Expectation:
- substantial pure-logic coverage already exists in Tier 1 (constructor parsing, ABI compat, deployment state I/O)
- deploy orchestration and network interactions belong in Tier 2
- one smoke path through example deploy belongs in Tier 3

### `packages/plugin-network`

Primary tiers:
- Tier 2

Coverage focus:
- task registration
- network manager injection via `extendLre()`

Expectation:
- thin orchestration plugin, covered primarily through boundary tests

### `packages/plugin-test`

Primary tiers:
- Tier 1
- Tier 2

Coverage focus:
- task registration and argument handling
- Vitest runner configuration
- compile/test task interaction

Expectation:
- argument handling and config validation belong in Tier 1
- runner integration and hook dispatch belong in Tier 2

### `packages/create-lionden`

Primary tiers:
- Tier 1
- Tier 3

Coverage focus:
- template rendering
- file tree creation
- example script and config correctness

Expectation:
- deterministic scaffolding tests plus one smoke path that verifies a scaffolded project actually works

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

This aligns with the current documented constraint that test isolation relies on fresh devnode lifecycle and fixture patterns rather than snapshots.

## Fixture Strategy

The existing `loadFixture()` helper should become the standard setup primitive for expensive state preparation.

Recommended usage:

- cache deployments per suite
- return structured handles such as `{ ctx, deployment, accounts }`
- make fixtures idempotent and narrowly scoped
- avoid implicit global mutable state outside the fixture cache

Recommended additions:

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

Future addition:

- fake process runner for `leo build` and `leo devnode`
- configurable stdout/stderr/exit codes
- recorded argv assertions
- synthetic artifacts directory population

Use for:

- compiler orchestration
- plugin task tests
- devnode manager command construction tests

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

Add:
- one local-mode semantic suite if wrapper generation or compile output grows more complex

### `examples/token`

Role:
- stateful workflow smoke test

Keep:
- on-chain mapping and block assertions

Change:
- move most semantic transition checks into local-mode tests
- use deployment fixtures instead of raw `beforeAll` setup for every file

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

### `examples/upgradeable-counter`

Role:
- upgrade workflow end-to-end smoke test

Keep:
- `@admin` constructor, upgrade task, ABI compat check
- `assertBalanceAtLeast` and `assertBlockHeightAtLeast` usage
- `configVariable()` and multi-network config demonstration

### `examples/async-escrow`

Role:
- typechain bindings usage in tests smoke test

Keep:
- generated TypeScript contract wrapper for all transitions
- escrow state machine lifecycle assertions

### Future Examples

Only add a new example when it represents a new workflow contract not covered by existing examples. Do not add examples just to increase raw test count.

## CI Lanes

The repo should expose explicit scripts for each lane.

### Required On Every PR

- `npm run test:unit`
- `npm run test:contract`

These two lanes form the PR quality gate. They must be fast and reliable enough to block on every pull request.

### Required On Most PRs

- `npm run test:smoke`

This lane should stay small enough to run on normal pull requests. The larger ported-example lane is available separately as:

- `npm run test:smoke:aleo-ports`

If runtime becomes too high, split the core smoke lane further and use changed-path filtering in CI.

### Nightly Or Release Lane

- `npm run test:smoke:all:prove`
- optional SDK compatibility lane against the supported toolchain matrix

## Current Script Surface

The current root scripts are:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:contract": "vitest run --project contract",
    "test:coverage": "vitest run --coverage",
    "test:agent": "vitest run --reporter=agent",
    "test:watch": "vitest",
    "test:smoke": "node scripts/run-smoke-examples.mjs core",
    "test:smoke:coverage": "node scripts/run-smoke-examples.mjs --coverage core",
    "test:smoke:prove": "node scripts/run-smoke-examples.mjs --prove core",
    "test:smoke:prove:coverage": "node scripts/run-smoke-examples.mjs --prove --coverage core",
    "test:smoke:aleo-ports": "node scripts/run-smoke-examples.mjs aleo-ports",
    "test:smoke:aleo-ports:coverage": "node scripts/run-smoke-examples.mjs --coverage aleo-ports",
    "test:smoke:aleo-ports:prove": "node scripts/run-smoke-examples.mjs --prove aleo-ports",
    "test:smoke:aleo-ports:prove:coverage": "node scripts/run-smoke-examples.mjs --prove --coverage aleo-ports",
    "test:smoke:all": "node scripts/run-smoke-examples.mjs all",
    "test:smoke:all:coverage": "node scripts/run-smoke-examples.mjs --coverage all",
    "test:smoke:all:prove": "node scripts/run-smoke-examples.mjs --prove all",
    "test:smoke:all:prove:coverage": "node scripts/run-smoke-examples.mjs --prove --coverage all"
  }
}
```

The existing `test` script is preserved as an alias for the full Vitest run (unit + contract). Lane-specific scripts (`test:unit`, `test:contract`) use Vitest named projects. Coverage is opt-in through `test:coverage` so default local and CI test runs stay fast and avoid generating coverage artifacts. Smoke tests delegate to `scripts/run-smoke-examples.mjs`, which invokes the CLI with `--config` for each example because the CLI discovers config from `process.cwd()` and the examples live outside the repo root's config scope. For each example, the runner compiles, runs `tsc -p <example>/tsconfig.json --noEmit`, then runs `lionden test`; pass `--no-typecheck` to skip the TypeScript check during local debugging. The runner keeps the curated core example list explicit and discovers `examples/aleo-ports/*/lionden.config.ts` dynamically. Most aleo-ports configs are pinned to `leoVersion: "4.0.0"` as the explicit 4.0 regression lane; when `leo` on `PATH` is a different line, run `npm run test:smoke:aleo-ports -- --leo-4-binary <path-to-leo-4.0>` or set `LIONDEN_LEO_4_0_BINARY=<path-to-leo-4.0>`. `dynamic_records` targets Leo 4.1.x for V15 dynamic-record coverage and can use `LIONDEN_LEO_4_1_BINARY=<path-to-leo-4.1>` when `leo` on `PATH` is not 4.1.x. The `test:agent` and `test:watch` scripts are already in use and documented in `AGENTS.md`.
Pass `--prove` to the smoke runner, or use one of the `*:prove` scripts, to forward `lionden test --prove --timeout 900000` into every selected example.
Pass `--coverage` to the smoke runner, or use one of the `*:coverage` scripts, to forward `lionden test --coverage` into each selected example. Each example emits a Vitest blob report under `.vitest/smoke-coverage/<lane>/blobs/` and temporary per-run coverage under `.vitest/smoke-coverage/<lane>/runs/`; after every selected example passes, the runner merges the blobs from the repo root into `coverage/smoke/<lane>/`. The merge is skipped when any example fails, preserving the smoke runner's fail-fast behavior.

Smoke lanes intentionally typecheck generated `typechain/**/*.ts` alongside example tests so wrapper API drift is caught before runtime-only tests can mask it.

## Vitest Project Configuration

The root Vitest config already uses named projects.

Current projects:

- `unit` — selects `packages/*/src/**/*.test.ts` excluding `*.contract.test.ts`
- `contract` — selects `packages/*/src/**/*.contract.test.ts`

Do not force smoke tests into the root Vitest project if they naturally belong to project-local `lionden test` runs.

## Coverage Policy

Coverage should be measured separately by lane.

Recommended policy:

- enforce coverage thresholds only for Tier 1 and selected Tier 2 suites
- do not block on coverage percentages for smoke or proof lanes
- keep root Vitest coverage scoped to package source under `packages/*/src/**/*.ts`, excluding test files, `packages/test-internals`, and checked-in `__goldens__` fixtures
- keep smoke coverage opt-in and reporting-only; use it to see which package implementation paths the real examples drive
- track smoke lane count, duration, and flake rate instead

Suggested initial targets:

- deterministic lines/branches threshold for `packages/config`, `packages/core`, and `packages/leo-compiler`
- no global monorepo threshold until lane separation is in place

## Failure Diagnostics

Expensive failures must produce useful artifacts.

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

## Incremental Rollout Plan

### Phase 0: Naming And Lane Separation

Status: mostly complete.

- this strategy doc exists
- root scripts expose `test`, `test:unit`, `test:contract`, `test:smoke`, `test:smoke:aleo-ports`, and `test:smoke:all`
- current tests remain colocated with owning packages and are classified through Vitest project names plus filename conventions

### Phase 1: Example Smoke Cleanup

Status: ongoing.

- convert example suites to use `mode: "local"` for semantic transition checks
- adopt `loadFixture()` for deploy setup in example tests
- reduce unnecessary devnode work in example projects
- this phase requires no new infrastructure and delivers immediate CI time savings

### Phase 2: Extract Shared Test Doubles

Status: partially complete.

- `packages/test-internals/` exists as the home for repo-owned test infrastructure
- `mock-config`, `mock-connection`, fake network, temp-project, and contract-LRE helpers exist there
- continue moving duplicated ad hoc mocks into that package when touching nearby tests

### Phase 3: Contract Harnesses And First Contract Tests

Status: partially complete.

- fake network and temp-project builders exist under `packages/test-internals`
- initial contract tests exist for CLI dispatch, deploy orchestration, upgrade orchestration, plugin-leo compile orchestration, and plugin-test task behavior
- the `contract` Vitest project and `test:contract` script exist
- remaining work is to expand coverage only where a package boundary needs it

### Phase 4: Compiler And Codegen Goldens

Status: ongoing.

- expand golden coverage for compiler output, package materialization, and TypeScript codegen
- copy stable fixture ABIs into `packages/leo-compiler/src/__fixtures__/` to decouple from example artifacts
- add edge-case fixtures for nested imports and multi-program graphs

### Phase 5: Proof Lane And Diagnostics

Status: not started.

- isolate proof-generation coverage into a dedicated CI lane
- preserve useful failure artifacts automatically
- establish runtime and flake budgets

## Remaining Near-Term Backlog

Keep the next backlog small and high leverage.

1. Continue converting example tests to use `mode: "local"` for semantic transition checks and `loadFixture()` for deploy setup.
2. Expand contract tests only at high-value boundaries that are still mostly covered through smoke tests.
3. Keep moving duplicated mocks into `packages/test-internals/` when nearby tests change.
4. Add more stable fixture ABIs and edge cases under `packages/leo-compiler/src/__fixtures__/` as codegen/parser coverage expands.
5. Add one nightly `--prove` smoke path.
6. Add failure-artifact capture for smoke and future proof lanes.

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
