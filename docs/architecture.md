# Architecture

When to read this: use this file for the plugin system, config lifecycle, task registration, LRE construction, and CLI boot flow. Skip it if your task is only about compiler, network, or testing internals.

## Current Architecture

LionDen is organized around declarative plugins plus a runtime environment created from resolved config.

The core public pieces live in:

- `packages/config` for user-facing config types
- `packages/core` for plugins, hooks, tasks, and LRE creation
- `packages/cli` for config discovery and task dispatch

## Config Model

Users define config with `defineConfig()` from `@lionden/config`. The user config shape includes:

- `plugins`
- `tasks`
- `networks`
- `defaultNetwork`
- `compiler`
- `codegen`
- `testing`
- `deploy`

Resolved config fills defaults and converts paths into absolute paths. Current defaults include:

- `leoVersion: "4.0.0"`
- `programsDir: "programs"`
- `artifactsDir: "artifacts"`
- `typechainDir: "typechain"`
- a default `devnode` network when no networks are configured
- testing timeout of `120_000`
- deploy confirmation timeout of `60_000`
- deployment state directory of `deployments`
- deployed-program skipping enabled by default
- deployment auto-export disabled by default

Config variables are supported through `configVariable()` and resolved during config resolution.

## Config Lifecycle

`packages/core/src/config-resolution.ts` implements a four-stage lifecycle:

1. `extendUserConfig`
2. `validateUserConfig`
3. `resolveConfig`
4. `validateResolvedConfig`

The current implementation resolves all config hook handlers from plugins up front, runs extension as a waterfall, aggregates validation errors, merges plugin-provided partial resolved config, and throws `ConfigResolutionError` with collected validation failures.

## Plugin Model

`packages/core/src/types.ts` defines `LionDenPlugin`. A plugin can provide:

- `id`
- `name`
- `dependencies`
- `conditionalDependencies`
- `hookHandlers`
- `tasks`
- `globalOptions`
- `extendLre`

`packages/core/src/plugin-loader.ts` performs dependency-first plugin ordering with cycle detection. Conditional dependencies are only included when the user already listed them.

Global option names are also validated centrally to prevent collisions between plugins.

## Hooks

Hook categories currently defined in core are:

- `config`
- `compilation`
- `network`
- `testing`
- `deployment`

`HookDispatcherImpl` is responsible for plugin hook registration and lazy handler loading. The config lifecycle resolves config hooks directly during config resolution; the runtime dispatcher handles the broader hook categories once the LRE exists.

## Tasks

Tasks are defined through the builder API in `packages/core/src/task-builder.ts` and executed by `TaskRunnerImpl`.

Key current behaviors:

- plugin tasks are registered first, then config-level tasks
- tasks may declare dependencies on other tasks
- task overrides stack on top of earlier tasks
- `runSuper` invokes the immediately preceding implementation chain
- CLI arguments are normalized from kebab-case to canonical option names
- numeric option values are coerced from strings when possible
- option defaults and flag defaults are filled before execution

This is the basis for the repo's built-in tasks such as `compile`, `node`, `deploy`, and `test`.

## LRE

The LionDen Runtime Environment is created in `packages/core/src/lre.ts`.

The current LRE includes:

- resolved config
- network service placeholder, later injected by plugins
- deployment manager placeholder, later injected by plugins
- task runner
- hook dispatcher
- in-memory artifact store
- resolved plugins
- collected global option values

`@lionden/plugin-network` currently uses `extendLre` to inject `NetworkManagerImpl` into `lre.network`.

`@lionden/plugin-deploy` currently uses `extendLre` to inject `DeploymentManagerImpl` into `lre.deployments`.

## CLI Boot Flow

`packages/cli/src/index.ts` currently performs this flow:

1. parse global CLI args
2. support early `--help` and `--version`
3. discover and load `lionden.config.{ts,js,mjs}`
4. resolve plugin order from `config.plugins`
5. collect plugin global options and parse again with that option set
6. resolve config through the four-stage lifecycle
7. create the LRE using resolved config and post-extension config tasks
8. print help or dispatch the selected task

`packages/cli/src/task-dispatch.ts` owns low-level argument parsing and help rendering.

## Built-In Plugin Set

The repo's examples and templates use four default plugins together:

- `@lionden/plugin-leo`
- `@lionden/plugin-network`
- `@lionden/plugin-deploy`
- `@lionden/plugin-test`

That bundle provides the current user-facing task surface.

## Design Direction

For product intent, roadmap framing, and the broader Hardhat-style target model, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the code paths above when you need the current implementation contract.
