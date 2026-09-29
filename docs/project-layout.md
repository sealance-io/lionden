# Project Layout

When to read this: use this file for repo orientation, package ownership, examples, and contributor entry points. Skip it if you already know the layout and only need one subsystem.

## Current Structure

LionDen is a workspace monorepo with code grouped by responsibility:

- `packages/config`: public config types and helpers such as `defineConfig()` and `configVariable()`
- `packages/core`: the plugin interface, hook system, task builder, task runner, config resolution, and LRE creation
- `packages/cli`: config discovery, argument parsing, help output, and task dispatch for `lionden`
- `packages/leo-compiler`: Leo source discovery, dependency resolution, temporary package materialization, `leo build` orchestration, caching, ABI parsing, and TypeScript codegen
- `packages/network`: network manager, connections, devnode lifecycle helpers, SDK adapter entrypoints
- `packages/testing`: test LRE creation, managed devnode lifecycle, fixtures, assertions, account helpers
- `packages/plugin-leo`: `compile` and `clean`
- `packages/plugin-network`: `node`, `run`, and LRE network injection
- `packages/plugin-deploy`: `deploy`, `upgrade`, `export`, `recipe`, and deployment state
- `packages/plugin-test`: `test` and Vitest integration
- `packages/create-lionden`: interactive scaffolding
- `packages/test-internals`: private repo-owned test fakes, temp-project builders, contract LRE helpers, and shared mocks

Top-level supporting paths:

- `examples/`: maintained example projects; see [Examples](#examples) for what each one demonstrates
- `examples/aleo-ports/`: one workspace per ported Aleo example, used for compatibility smoke coverage (`npm run test:smoke:aleo-ports`); `admin`/`noupgrade`/`timelock` cover Leo constructor/upgrade compatibility
- `docs/`: focused implementation docs

## Contributor Entry Points

Useful starting points for common repo tasks:

- CLI behavior: `packages/cli/src/index.ts`
- config lifecycle: `packages/core/src/config-resolution.ts`
- plugin ordering: `packages/core/src/plugin-loader.ts`
- task execution: `packages/core/src/task-runner.ts`
- compile orchestration: `packages/leo-compiler/src/compiler.ts`
- network service injection: `packages/plugin-network/src/index.ts`
- plugin-deploy task registration and `lre.deployments` injection: `packages/plugin-deploy/src/index.ts`
- deployment state: `packages/plugin-deploy/src/deployment-state.ts`, `packages/plugin-deploy/src/deployment-manager.ts`
- test context: `packages/testing/src/test-context.ts`
- private test fakes and builders: `packages/test-internals/src/index.ts`

## Examples

`examples/hello-world` is the smallest useful reference:

- one main config file (`lionden.config.ts`; the `lionden.config.backend-*.ts` variants exist only for the deploy-backend parity check)
- one Leo program
- one deployment script
- one test file

`examples/token` is better when you need to inspect realistic flows:

- mapping reads and writes
- private and public transitions
- richer test assertions
- deploy configuration

`examples/multi-program` demonstrates cross-program interactions:

- multiple programs with inter-program calls
- dependency graph resolution
- typechain usage for typed contract wrappers

`examples/nft-registry` showcases structs, records, and test patterns:

- struct and record definitions with `field` type
- `loadFixture()` for shared test setup
- local execution mode (no finalize)

`examples/async-escrow` demonstrates typechain bindings in tests:

- generated TypeScript contract wrappers for all transitions
- escrow state machine with on-chain status transitions
- typed mapping reads via `escrow.mappings.escrowStatus.get()` for verifying mapping state

`examples/renamed_dynamic_records` demonstrates renamed deployment with dynamic records:

- deploying `gold_token.aleo` as `tenant_gold.aleo` with `deploy --program gold_token --rename tenant_gold`
- runtime dynamic dispatch into the renamed program
- successful admin-authorized upgrade by the renamed runtime id

When documenting user workflows, prefer checking the examples before inventing examples from scratch.

## Scaffolding

`packages/create-lionden` currently scaffolds two templates:

- `hello-world`
- `token`

The scaffolded output includes:

- `package.json`
- `tsconfig.json`
- `.gitignore`
- `lionden.config.ts`
- `programs/...`
- `recipes/setup.ts` (token template only)
- `scripts/deploy.ts`
- `test/...`

The template registry lives in `packages/create-lionden/src/templates.ts`.
Generated `@lionden/*` dependency ranges come from `create-lionden`'s own package version, not
literal per-package versions. All public packages share one Changesets fixed release group, so
the scaffolder and generated toolchain stay on the same pre-1.0 compatibility line.

## Documentation Usage

Use this doc for navigation only. For behavior-level detail, pick the subsystem doc from the
README [Documentation Map](../README.md#documentation-map).

## Design Direction

For roadmap context and intended future package behavior beyond what the current code exposes, use [`vision-and-roadmap.md`](vision-and-roadmap.md).
