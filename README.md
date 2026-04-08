# LionDen

LionDen is a Hardhat-inspired development framework for Aleo and Leo. It combines a declarative plugin system, a task-driven CLI, Leo compilation and TypeScript code generation, devnode/devnet network tooling, and test helpers for end-to-end workflows.

This repository currently contains a working monorepo baseline with core packages, default plugins, example projects, and a project scaffolder. The public documentation under `docs/` covers both the current implementation and the design direction that shapes ongoing work.

## Status

LionDen is in active early development.

Implemented in the repo today:

- npm workspaces monorepo with ESM TypeScript packages
- `@lionden/config` for typed config and configuration variables
- `@lionden/core` for plugin ordering, config resolution, hook dispatch, task registration, task overrides, and LRE creation
- `@lionden/cli` for config discovery, help output, argument parsing, and task dispatch
- `@lionden/leo-compiler` for source discovery, dependency resolution, package materialization, Leo compilation, ABI parsing, caching, and TypeScript binding generation
- `@lionden/network` for devnode/devnet/HTTP connections and SDK initialization helpers
- default plugins for compilation, network tasks, deploy/upgrade, and testing
- `@lionden/testing` for devnode lifecycle, fixtures, assertions, and test setup helpers
- `create-lionden` scaffolding with `hello-world` and `token` templates
- example projects under `examples/`

Important design-direction material is captured in:

- [`docs/vision-and-roadmap.md`](/Users/mitzpetel/Workspaces/lionden/docs/vision-and-roadmap.md)

When the code and the plan differ, treat the current codebase as the source of truth for shipped behavior.

## Monorepo Layout

| Path | Purpose |
| --- | --- |
| `packages/config` | Config types, `defineConfig()`, `configVariable()` |
| `packages/core` | Plugin model, hook system, task builder, task runner, LRE |
| `packages/cli` | `lionden` CLI entrypoint and config discovery |
| `packages/network` | Network manager, Aleo connection, devnode/devnet lifecycle |
| `packages/leo-compiler` | Leo source discovery, package materialization, `leo build`, ABI/codegen |
| `packages/testing` | Test context, fixtures, assertions, managed devnode helpers |
| `packages/plugin-leo` | `compile` and `clean` tasks |
| `packages/plugin-network` | `node` and `run` tasks, LRE network service |
| `packages/plugin-deploy` | `deploy` and `upgrade` tasks |
| `packages/plugin-test` | `test` task with Vitest integration |
| `packages/create-lionden` | Project scaffolder |
| `examples/hello-world` | Minimal example project |
| `examples/token` | Richer example with mappings and private/public flows |
| `docs/` | Focused deep dives for lazy loading |

## Prerequisites

For contributor workflows and realistic end-to-end runs, assume:

- Node.js 20.19+ or 22.12+ (the root package declares `^20.19.0 || >=22.12.0`)
- npm
- Leo CLI v4.0.0 available on `PATH`
- snarkOS available when working on devnet-oriented flows

Network functionality depends on `@provablehq/sdk@^0.10.1` via `packages/network`.

## Getting Started

Install workspace dependencies:

```bash
npm install
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
  leoVersion: "4.0.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  testing: { timeout: 120_000 },
});
```

The repo examples under `examples/hello-world` and `examples/token` follow this pattern.

## Current CLI Task Surface

The default plugins in this repo register these primary tasks:

- `compile`: compile Leo programs and optionally generate TypeScript bindings
- `clean`: remove artifacts and generated bindings
- `node`: start a local Aleo devnode
- `run <script>`: execute a TypeScript deployment or utility script with LRE context
- `deploy`: deploy compiled programs to the target network
- `upgrade`: upgrade a deployed program
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

## Documentation Map

Start here for overview, then open only the subsystem docs you need:

- [`docs/project-layout.md`](/Users/mitzpetel/Workspaces/lionden/docs/project-layout.md): package map, examples, scaffolding, contributor entry points
- [`docs/vision-and-roadmap.md`](/Users/mitzpetel/Workspaces/lionden/docs/vision-and-roadmap.md): product goals, design decisions, Leo/SDK baseline, roadmap, known challenges
- [`docs/architecture.md`](/Users/mitzpetel/Workspaces/lionden/docs/architecture.md): plugin model, config lifecycle, tasks, LRE, CLI boot flow
- [`docs/compiler.md`](/Users/mitzpetel/Workspaces/lionden/docs/compiler.md): source discovery, dependency resolution, materialization, `leo build`, ABI/codegen
- [`docs/network-and-deploy.md`](/Users/mitzpetel/Workspaces/lionden/docs/network-and-deploy.md): network types, devnode/devnet, run/deploy/upgrade flows
- [`docs/testing.md`](/Users/mitzpetel/Workspaces/lionden/docs/testing.md): `@lionden/testing`, managed devnode lifecycle, fixtures, assertions, test runner behavior
- [`AGENTS.md`](/Users/mitzpetel/Workspaces/lionden/AGENTS.md): agent-specific navigation and selective disclosure rules

## Roadmap Framing

The codebase already matches a meaningful part of the intended design:

- typed config and plugin registration
- config lifecycle stages
- task registry and override support
- compiler pipeline with Leo package materialization
- network manager and default plugins
- test helpers and scaffolded examples

The design-direction docs still go further than the current implementation in places. Use them to understand direction, package boundaries, and intended end state, but not as a guarantee that every planned interface is already complete.
