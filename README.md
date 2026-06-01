# LionDen

LionDen is a Hardhat-inspired development framework for Aleo and Leo. It combines a declarative plugin system, a task-driven CLI, Leo compilation and TypeScript code generation, devnode/HTTP network tooling, and test helpers for end-to-end workflows.

This repository currently contains a working monorepo baseline with core packages, default plugins, example projects, and a project scaffolder. The public documentation under `docs/` covers both the current implementation and the design direction that shapes ongoing work.

## Status

LionDen is in active early development.

Implemented in the repo today:

- npm workspaces monorepo with ESM TypeScript packages
- `@lionden/config` for typed config and configuration variables
- `@lionden/core` for plugin ordering, config resolution, hook dispatch, task registration, task overrides, and LRE creation
- `@lionden/cli` for config discovery, help output, argument parsing, and task dispatch
- `@lionden/leo-compiler` for source discovery, dependency resolution, package materialization, Leo compilation, ABI parsing, caching, and TypeScript binding generation
- `@lionden/network` for devnode/HTTP connections and SDK initialization helpers
- default plugins for compilation, network tasks, deploy/upgrade/export, and testing
- `@lionden/testing` for devnode lifecycle, fixtures, assertions, and test setup helpers
- `create-lionden` scaffolding with `hello-world` and `token` templates
- example projects under `examples/`

Important design-direction material is captured in:

- [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md)

When the code and the plan differ, treat the current codebase as the source of truth for shipped behavior.

## Monorepo Layout

| Path | Purpose |
| --- | --- |
| `packages/config` | Config types, `defineConfig()`, `configVariable()` |
| `packages/core` | Plugin model, hook system, task builder, task runner, LRE |
| `packages/cli` | `lionden` CLI entrypoint and config discovery |
| `packages/network` | Network manager, Aleo connection, devnode lifecycle |
| `packages/leo-compiler` | Leo source discovery, package materialization, `leo build`, ABI/codegen |
| `packages/testing` | Test context, fixtures, assertions, managed devnode helpers |
| `packages/plugin-leo` | `compile` and `clean` tasks |
| `packages/plugin-network` | `node` and `run` tasks, LRE network service |
| `packages/plugin-deploy` | `deploy`, `upgrade`, and `export` tasks |
| `packages/plugin-test` | `test` task with Vitest integration |
| `packages/create-lionden` | Project scaffolder |
| `packages/test-internals` | Repo-private test fakes, builders, and shared mocks |
| `examples/hello-world` | Minimal example project |
| `examples/token` | Richer example with mappings and private/public flows |
| `examples/multi-program` | Cross-program calls, dependency graph, typechain |
| `examples/nft-registry` | Structs, records, `loadFixture`, local execution mode |
| `examples/upgradeable-counter` | `@admin` constructor, upgrade flow, multi-network config |
| `examples/async-escrow` | Typechain bindings in tests, escrow state machine |
| `examples/aleo-ports` | Ported Aleo examples used for compatibility smoke coverage |
| `docs/` | Focused deep dives for lazy loading |

## Prerequisites

For contributor workflows and realistic end-to-end runs, assume:

- Node.js 20.19+ or 22.12+ (the root package declares `^20.19.0 || >=22.12.0`)
- npm
- Leo CLI v4.1.x available on `PATH` by default. Leo v4.0.x remains an explicit compatibility line, and Leo v3.5.x is supported for deployable programs via `leoVersion` and `leoBinary` — see [`docs/leo-version-compatibility.md`](docs/leo-version-compatibility.md)


Network functionality depends on `@provablehq/sdk@^0.11.0` via `packages/network`.

## Getting Started

New to LionDen? Read [`docs/usage.md`](docs/usage.md) for a user-facing walkthrough of the day-to-day workflow (configure, compile, test, deploy, upgrade, export).

Install workspace dependencies:

```bash
npm install --ignore-scripts
```

Build all packages:

```bash
npm run build
```

Run the test suite:

```bash
npm test
```

Run the CLI directly from source:

```bash
node --import tsx packages/cli/src/bin.ts --help
```

Run the scaffolder directly from source:

```bash
node --import tsx packages/create-lionden/src/bin.ts my-app --template hello-world
```

## LionDen Project Shape

A typical project uses a `lionden.config.ts` file plus source-first Leo programs under `programs/`.

```ts
import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.1.0",
  // leoVersion declares a compatibility line; leoBinary controls the CLI that runs.
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  testing: { timeout: 120_000 },
});
```

The repo examples under `examples/` follow this pattern.

## Current CLI Task Surface

The default plugins in this repo register these primary tasks:

- `compile`: compile Leo programs and optionally generate TypeScript bindings
- `clean`: remove artifacts and generated bindings
- `node`: start a local Aleo devnode
- `run <script>`: execute a TypeScript deployment or utility script with LRE context
- `deploy`: deploy compiled programs to the target network
- `upgrade`: upgrade a deployed program
- `export`: export deployment addresses and ABIs
- `recipe`: run a reusable deployment recipe from a TypeScript module
- `test`: run Vitest suites with LionDen-managed setup and teardown

From the repo root, a typical source-level workflow is:

```bash
node --import tsx packages/cli/src/bin.ts compile
node --import tsx packages/cli/src/bin.ts test
node --import tsx packages/cli/src/bin.ts node
```

In a scaffolded project, the intended workflow is through the installed `lionden` binary or package scripts.

## Development Flow

Compile Leo sources and generate bindings:

```bash
node --import tsx packages/cli/src/bin.ts compile
```

Run tests with managed devnode lifecycle:

```bash
node --import tsx packages/cli/src/bin.ts test
```

Run a deployment script:

```bash
node --import tsx packages/cli/src/bin.ts run examples/hello-world/scripts/deploy.ts
```

Start a devnode:

```bash
node --import tsx packages/cli/src/bin.ts node --port 3030
```

## Architecture Summary

LionDen is built around a few core ideas:

- Declarative plugins: users add plugin objects in config rather than relying on side-effect imports.
- Config lifecycle: user config is extended, validated, resolved, then validated again before runtime creation.
- Task-driven CLI: plugins register tasks, tasks can override prior tasks, and the CLI dispatches into the resolved task registry.
- Source-first compilation: users author Leo sources in `programs/`; LionDen materializes temporary Leo packages under artifacts for `leo build`.
- Runtime environment: the LRE bundles resolved config, tasks, hooks, artifacts, plugins, and network services.
- Test ergonomics: `@lionden/testing` creates or discovers an LRE, manages devnode lifecycle, and exposes assertions and fixtures for Vitest suites.

For subsystem detail, use the focused docs in `docs/` instead of loading everything at once.

## Examples

`examples/hello-world` shows the smallest usable setup:

- one Leo program
- one deployment script
- one Vitest suite

`examples/token` demonstrates a more realistic flow:

- mappings
- private and public transitions
- richer test assertions via `@lionden/testing`

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
- `assertBalanceAtLeast` and `assertBlockHeightAtLeast`

`examples/async-escrow` demonstrates typechain bindings in tests:

- generated TypeScript contract wrappers for all transitions
- escrow state machine with on-chain status transitions
- `assertMappingValue` for verifying mapping state

## Documentation Map

Start here for overview, then open only the subsystem docs you need:

- [`docs/usage.md`](docs/usage.md): day-to-day usage guide — configure, compile, test, deploy, upgrade, export
- [`docs/feature-status.md`](docs/feature-status.md): what's shipped, what's missing for V1, what's deferred — with a doko-js parity reference
- [`docs/project-layout.md`](docs/project-layout.md): package map, examples, scaffolding, contributor entry points
- [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md): product goals, design decisions, Leo/SDK baseline, roadmap, known challenges
- [`docs/architecture.md`](docs/architecture.md): plugin model, config lifecycle, tasks, LRE, CLI boot flow
- [`docs/compiler.md`](docs/compiler.md): source discovery, dependency resolution, materialization, `leo build`, ABI/codegen
- [`docs/network.md`](docs/network.md): network types, devnode/HTTP, SDK integration, `node`, and `run`
- [`docs/deployment.md`](docs/deployment.md): deploy, upgrade, export, deployment state, preflight, and hooks
- [`docs/testing.md`](docs/testing.md): `@lionden/testing`, managed devnode lifecycle, fixtures, assertions, test runner behavior
- [`docs/testing-strategy.md`](docs/testing-strategy.md): proposed repo-wide testing strategy, lane split, ownership, CI plan
- [`docs/json-abi.md`](docs/json-abi.md): JSON ABI schema, parser normalization, and generated binding type rules
- [`docs/leo-version-compatibility.md`](docs/leo-version-compatibility.md): Leo v4 default behavior plus scoped v3.5 compatibility
- [`docs/agent-bug-hunt-workflow.md`](docs/agent-bug-hunt-workflow.md): disposable agent-driven bug-hunt probe workflow
- [`AGENTS.md`](AGENTS.md): agent-specific navigation and selective disclosure rules

## Roadmap Framing

The codebase already matches a meaningful part of the intended design:

- typed config and plugin registration
- config lifecycle stages
- task registry and override support
- compiler pipeline with Leo package materialization
- network manager and default plugins
- test helpers and scaffolded examples

The design-direction docs still go further than the current implementation in places. Use them to understand direction, package boundaries, and intended end state, but not as a guarantee that every planned interface is already complete.
