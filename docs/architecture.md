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
- `namedAccounts`
- `compiler`
- `codegen`
- `testing`
- `deploy`

Resolved config fills defaults and converts paths into absolute paths. Current defaults include:

- `leoVersion: "4.1.0"`
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

The current implementation routes config hooks through a standalone `HookDispatcherImpl` (the LRE does not exist yet at this boot phase): `extendUserConfig` runs as a waterfall, `validateUserConfig`/`validateResolvedConfig` aggregate via `collect`, and plugin-provided partial resolved configs are merged from a `collect` pass. It throws `ConfigResolutionError` with collected validation failures. Lazy hook factories resolve once and are shared across all four stages via the dispatcher's single-flight cache.

Both `validateUserConfig` and `validateResolvedConfig` run two passes: core-owned built-in validators first (for fields like `execution.imports` that belong to the core config schema rather than to any plugin), then plugin-contributed handlers. Built-in validators sit inline in `resolveConfig()` and accumulate `ConfigValidationError`s alongside handler results — there is no separate hook surface for them. Path-existence checks on `execution.imports` happen in the resolved-config pass, where `paths.root` is available to anchor relative refs.

## Plugin Model

`packages/core/src/types.ts` defines `LionDenPlugin`. A plugin can provide:

- `id`
- `name`
- `dependencies`
- `hookHandlers`
- `tasks`
- `globalOptions`
- `extendLre`

`packages/core/src/plugin-loader.ts` performs dependency-first plugin ordering with cycle detection.

Global option names are also validated centrally to prevent collisions between plugins.

## Hooks

Hook categories currently defined in core are:

- `config`
- `testing`
- `deployment`

`HookDispatcherImpl` is responsible for plugin hook registration and lazy handler loading, and exposes three dispatch modes: `serial`, `waterfall`, and `collect`. The config lifecycle drives its category through a standalone dispatcher during config resolution (before the LRE exists); the LRE's dispatcher handles `testing` and `deployment` (both via `serial`) once the LRE is created.

## Tasks

Tasks are defined through the builder API in `packages/core/src/task-builder.ts` and executed by `TaskRunnerImpl`.

Key current behaviors:

- plugin tasks are registered first, then config-level tasks
- task overrides stack on top of earlier tasks
- `runSuper` invokes the immediately preceding implementation chain
- CLI arguments are normalized from kebab-case to canonical option names
- named CLI arguments are assigned to global args or task args by public name lookup against registered schemas, not by whether the token appears before or after the task id
- the final task-aware CLI parse is validated before dispatch, so unknown tasks, unknown named arguments, bare arguments before the resolved task, and unused after-task positional arguments are rejected centrally
- numeric option values are coerced from strings when possible
- option defaults and flag defaults are filled before execution
- positional arguments are bound by index to their declared names (`_positional` stays populated for back-compat), variadic positionals can consume multiple bare arguments, and a missing `required` positional throws before the action runs

This is the basis for the repo's built-in tasks such as `compile`, `node`, `deploy`, and `test`.

## LRE

The LionDen Runtime Environment is created in `packages/core/src/lre.ts`.

The current LRE includes:

- resolved config
- network service placeholder, later injected by plugins
- deployment manager placeholder, later injected by plugins
- `namedAccounts` getter — returns resolved named accounts for the active network (populated by `@lionden/plugin-network` after `connect()`, empty before)
- task runner
- hook dispatcher
- in-memory artifact store
- resolved plugins
- collected global option values

`@lionden/plugin-network` currently uses `extendLre` to inject `NetworkManagerImpl` into `lre.network` and define the `lre.namedAccounts` getter backed by `NetworkManagerImpl.getNamedAccounts()`.

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
8. parse again with task metadata so named arguments are routed by schema, not by position
9. render help (if requested) **before** validating option values, so an invocation like `--network ghostnet --help` still documents recovery instead of failing on the bad value
10. validate the final parse against the resolved task registry, rejecting unknown tasks, unknown named task/global arguments, bare arguments before the resolved task, and after-task bare arguments that the resolved task's positional schema cannot consume
11. apply the global `--network` override from that task-aware parse to `config.defaultNetwork` (validated against `config.networks`) **and** seed it into `globalOptions["network"]` so the `test` task can bridge it to Vitest workers via `LIONDEN_NETWORK` (other tasks keep reading `config.defaultNetwork`)
12. seed the built-in `--prove` preference into `globalOptions` — a presence test preserves an explicit `--prove=false`; unlike `--network`, this does **not** mutate config
13. seed plugin global option values from the task-aware parse
14. validate task named arguments do not overlap with built-in or plugin global options
15. dispatch the selected task

The built-in globals are `--config`, `--network`, `--prove`, `--verbose`, `--help`/`-h`, and `--version`/`-v` (see `BUILT_IN_GLOBAL_ARGUMENT_NAMES` in `packages/core/src/arg-names.ts`). These names are reserved: a plugin global or task argument that shadows one is rejected at load/build time. `--prove` is consumed by deploy/upgrade/recipe/test via `resolveProveOption()` / `lre.globalOptions["prove"]`; it is not owned by any single plugin.

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
