# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

```bash
npm install --ignore-scripts   # install workspace dependencies
npm run build                  # tsc --build (all packages via project references)
npm run clean                  # tsc --build --clean
npm test                       # vitest run (all unit + contract tests)
npm run test:unit              # unit tests only
npm run test:contract          # contract tests only
npm run test:agent             # vitest run with the agent reporter
npm run test:smoke             # example project smoke tests (requires build)
npx vitest run packages/core   # run tests for a single package
npx vitest run --reporter=agent packages/core   # targeted run with minimal agent output
npx vitest run packages/core/src/hook-system.test.ts  # run a single test file
```

Run the CLI from source (requires build first):
```bash
node --import tsx packages/cli/src/bin.ts --help
node --import tsx packages/cli/src/bin.ts --config examples/hello-world/lionden.config.ts compile
```

## Architecture at a Glance

npm workspaces monorepo, ESM-only (`"type": "module"`), TypeScript with composite project references. 11 packages, 6 examples. Requires Node `^20.19.0 || >=22.12.0` and Leo CLI v4 on `PATH`.

**Dependency flow** (each layer depends only on layers above it):

```
config                          zero deps — types + defineConfig()
core                            config — plugins, hooks, tasks, config lifecycle, LRE
leo-compiler / network          core — compiler pipeline / network+devnode
testing                         core + network + leo-compiler
plugin-{leo,network,deploy,test}  register tasks using the layers above
cli                             core + config — config discovery, argv parsing, task dispatch
create-lionden                  standalone scaffolder (no runtime deps)
```

Plugins are **declarative**: users list them in `defineConfig({ plugins: [...] })`. There is no auto-discovery. The four built-in plugins (`plugin-leo`, `plugin-network`, `plugin-deploy`, `plugin-test`) must all be explicitly registered in config to get the standard task set (`compile`, `clean`, `node`, `run`, `deploy`, `upgrade`, `test`).

**Config lifecycle** (4 stages in `packages/core/src/config-resolution.ts`):
`extendUserConfig` -> `validateUserConfig` -> `resolveConfig` -> `validateResolvedConfig`

**CLI boot** (`packages/cli/src/index.ts`): discover config -> load plugins -> collect global options -> resolve config through lifecycle -> create LRE -> dispatch task.

## Key Patterns

- **All imports use `.js` extensions** (ESM NodeNext resolution). Write `import { foo } from "./bar.js"` even though the source file is `bar.ts`.
- **Tests are colocated** with source as `*.test.ts` (unit) and `*.contract.test.ts` (cross-package) under `packages/*/src/`. See `docs/testing-strategy.md` for the tier taxonomy.
- **Agent test runs should prefer Vitest's `agent` reporter** to reduce token-heavy passing output. Use `npm run test:agent` for the full suite or `npx vitest run --reporter=agent ...` for targeted runs.
- **Plugin shape**: `{ id, name, hookHandlers?, tasks?, globalOptions?, extendLre? }` — see `packages/core/src/types.ts` for `LionDenPlugin`.
- **Task builder API**: `task(id, desc).addOption({...}).setAction(fn).build()` and `overrideTask(id).setAction(fn).build()` — see `packages/core/src/task-builder.ts`.
- **Source-first Leo layout**: users write `.leo` files in `programs/` without `program.json`. The compiler materializes Leo CLI packages internally during `compilePipeline()`.
- **Config variable resolution is eager**: `configVariable()` values are resolved for ALL networks during config resolution, not lazily for the active network. A `configVariable()` without a default will throw even on devnode runs if the env var is unset.

## Leo v4 Syntax

This repo targets Leo v4 by default. Leo v3.5 is supported for deployable programs — see `docs/leo-version-compatibility.md`. Key v4 syntax differences from earlier Leo versions:

- `fn` keyword (not `transition`). Functions that touch on-chain state return `-> Final` (not `-> Future`).
- Finalize blocks use `return final { ... }` inline. Cross-program finalize composition uses `.run()`.
- Constructors use decorators: `@noupgrade` for immutable programs, `@admin(address="aleo1...")` for upgradeable programs.
- Mappings: `mapping name: KeyType => ValueType;` with `name.get()`, `name.get_or_use()`, `name.set()` inside `final` blocks.
- Records and structs are declared with `record Name { ... }` and `struct Name { ... }`.
- `self.signer` gives the caller address, `self.caller` gives the immediate caller (may differ in cross-program calls).

## Documentation Map

Read `AGENTS.md` for navigation rules and selective disclosure guidance. Load only the subsystem doc relevant to your task:

| Topic | Doc |
| --- | --- |
| Plugin model, config lifecycle, tasks, LRE, CLI boot | `docs/architecture.md` |
| Leo compilation, materialization, ABI, codegen | `docs/compiler.md` |
| Network types, devnode/HTTP, deploy/upgrade | `docs/network-and-deploy.md` |
| Test context, fixtures, assertions | `docs/testing.md` |
| Repo-wide test strategy, CI lanes, tier taxonomy | `docs/testing-strategy.md` |
| JSON ABI schema, serde rules, compiler-vs-TS normalization | `docs/json-abi.md` |
| Package map, examples, scaffolder | `docs/project-layout.md` |
| Leo version support, v3.5 compat, `leoBinary`, consensus heights | `docs/leo-version-compatibility.md` |

`_docs/` contains design specs and implementation plan — treat as roadmap, not source of truth. When code and plan differ, trust the code.

## npm Security

Always use `--ignore-scripts` with npm install/ci.
