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
- `packages/plugin-deploy`: `deploy`, `upgrade`, constructor and manifest helpers
- `packages/plugin-test`: `test` and Vitest integration
- `packages/create-lionden`: interactive scaffolding

Top-level supporting paths:

- `examples/hello-world`: minimal project example
- `examples/token`: fuller example with mappings and richer tests
- `examples/multi-program`: cross-program calls and dependency graph
- `examples/nft-registry`: structs, records, `loadFixture`, local mode
- `examples/upgradeable-counter`: `@admin` constructor, upgrade flow, multi-network config
- `examples/async-escrow`: typechain bindings in tests, escrow state machine
- `docs/`: focused implementation docs

## Contributor Entry Points

Useful starting points for common repo tasks:

- CLI behavior: `packages/cli/src/index.ts`
- config lifecycle: `packages/core/src/config-resolution.ts`
- plugin ordering: `packages/core/src/plugin-loader.ts`
- task execution: `packages/core/src/task-runner.ts`
- compile orchestration: `packages/leo-compiler/src/compiler.ts`
- network service injection: `packages/plugin-network/src/index.ts`
- test context: `packages/testing/src/test-context.ts`

## Examples

`examples/hello-world` is the smallest useful reference:

- one config file
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

`examples/upgradeable-counter` exercises the upgrade workflow:

- `@admin` constructor for upgrade authorization
- end-to-end upgrade flow with ABI compatibility
- multi-network configuration (devnode + commented testnet with `configVariable()`)

`examples/async-escrow` demonstrates typechain bindings in tests:

- generated TypeScript contract wrappers
- escrow state machine with on-chain status transitions

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
- `scripts/deploy.ts`
- `test/...`

The template registry lives in `packages/create-lionden/src/templates.ts`.

## Documentation Usage

Use this doc for navigation only. For behavior-level detail:

- plugin/task/config mechanics: [`architecture.md`](/Users/mitzpetel/Workspaces/lionden/docs/architecture.md)
- compile pipeline: [`compiler.md`](/Users/mitzpetel/Workspaces/lionden/docs/compiler.md)
- networks and deployment: [`network-and-deploy.md`](/Users/mitzpetel/Workspaces/lionden/docs/network-and-deploy.md)
- test helpers: [`testing.md`](/Users/mitzpetel/Workspaces/lionden/docs/testing.md)
- repo-wide test strategy and CI: [`testing-strategy.md`](/Users/mitzpetel/Workspaces/lionden/docs/testing-strategy.md)
- JSON ABI schema and codegen types: [`json-abi.md`](/Users/mitzpetel/Workspaces/lionden/docs/json-abi.md)
- product goals and roadmap: [`vision-and-roadmap.md`](/Users/mitzpetel/Workspaces/lionden/docs/vision-and-roadmap.md)

## Design Direction

For roadmap context and intended future package behavior beyond what the current code exposes, use [`vision-and-roadmap.md`](/Users/mitzpetel/Workspaces/lionden/docs/vision-and-roadmap.md).
