# Vision And Roadmap

When to read this: use this file for product intent, design constraints, platform assumptions, roadmap context, and known challenges. Skip it if you only need current subsystem behavior.

## Why LionDen Exists

Aleo and Leo need a framework that plays the role Hardhat played for Ethereum development:

- declarative plugin-driven extensibility
- a consistent CLI and task model
- predictable config resolution
- better local development ergonomics
- code generation and testing built around actual compiler output

LionDen is the attempt to provide that baseline for Leo v4-era development.

## Product Direction and Key Design Decisions

These principles are broader than the current implementation and should be read as design direction rather than a claim that every interface is already complete. The major decisions preserved from the original planning material are:

1. ESM-native package and runtime model in a TypeScript monorepo.
2. Lazy loading where possible to keep CLI startup cheap.
3. Devnode-first local workflows, with `http` for connecting to external networks. See [`network.md`](network.md).
4. ABI-driven TypeScript bindings: code generation from compiler ABI output rather than regex-driven parsing of generated Aleo source. See [`compiler.md`](compiler.md) and [`json-abi.md`](json-abi.md).
5. Support for local-style and on-chain-style execution flows in generated and runtime tooling.
6. Vitest as the test runner instead of a custom LionDen-owned framework. See [`testing.md`](testing.md).
7. Leo v4 is the primary baseline; Leo v3.5 support is intentionally scoped to deployable `main.leo` programs and compatibility workflows, not full library support. See [`leo-version-compatibility.md`](leo-version-compatibility.md).
8. Source-first authoring in `programs/`, with LionDen materializing compiler-friendly package layouts internally.
9. A Hardhat-like declarative plugin surface with config lifecycle hooks and task composition. See [`architecture.md`](architecture.md).
10. A Provable SDK baseline aligned with devnode-aware APIs.
11. A small external dependency surface. `@provablehq/sdk` and its transitive dependencies are the deliberate heavyweight exception; other third-party runtime dependencies should be rare, justified by clear framework value, and isolated behind narrow package boundaries.

## Platform Baseline

Several platform facts are important when working on LionDen:

- Leo v4 changed core language and tooling assumptions, including unified `fn` syntax and library support via `lib.leo`.
- A local devnode is the primary lightweight local-development target. With no pinned `provider`, LionDen auto-detects Provable's standalone `aleo-devnode` on `PATH` and otherwise falls back to `leo devnode`; an explicit `provider` (or a standalone-only option) overrides auto-detection. See [`network.md`](network.md#backend-selection).
- Users who need a multi-validator network can run snarkOS externally and connect via `http`.
- `leo build` produces structured JSON ABI output that LionDen treats as the source of truth for wrapper generation.
- Upgradability depends on constructor behavior and compatibility constraints (immutability, ABI compatibility, edition continuity), but those rules are owned by Leo's built-in tooling. LionDen deliberately does not re-validate them (an earlier upgrade-correctness validation subsystem was removed as a scope reduction): its `upgrade` task recompiles the new version, builds and broadcasts the upgrade transaction, and records the result against persisted deploy state. See [`deployment.md`](deployment.md).

These assumptions explain many of the repo's current package boundaries and task names.

## Roadmap Shape

The implementation work is organized conceptually in these layers:

1. Foundation: config, core plugin model, task system, CLI boot flow.
2. Compilation: source discovery, dependency resolution, temporary package materialization, `leo build`, ABI parsing, code generation.
3. Network abstraction: devnode/HTTP connections, runtime network manager, `node` and `run`.
4. Deployment: deploy, the thin `upgrade` task, export, and deployment state.
5. Testing: managed devnode lifecycle, reusable test context, fixtures, assertions, Vitest integration.
6. Scaffolding and examples: `create-lionden`, starter templates, example projects.

This roadmap is useful for understanding intent and package boundaries even when current implementation depth varies by area.

## Known Challenges

The most important engineering constraints preserved from the original design work are:

- SDK compatibility matters. The network layer expects a modern `@provablehq/sdk` surface with devnode-aware functionality.
- SDK initialization is nontrivial and should stay isolated in adapter code.
- Proof generation is slow enough that long test timeouts are normal.
- Test isolation defaults to a fresh devnode lifecycle. `loadFixture()` is a separate mechanism: it caches expensive setup (such as deployments) for reuse and does not reset chain state. `setup({ snapshotReset: true })` only enables snapshot/restore on the standalone `aleo-devnode` backend; restore is explicit (there is no automatic per-test reset), so fast per-test isolation requires calling `ctx.snapshot()` / `ctx.restore()` in the suite. See [`testing.md`](testing.md#snapshot-based-fast-reset).
- Network dependency fetching depends on reachable endpoints and local caching.
- Package materialization must preserve nested source layout, or Leo imports break.
- Leo libraries and deployable programs must be treated differently in compile, codegen, and deploy flows.
- Constructor decorators remain required Leo syntax for deployable programs, even though LionDen does not enforce the upgrade rules they declare (see [Platform Baseline](#platform-baseline)).
- Compile-time proving-key synthesis is deferred. `synthesizeKeyPair` in the Provable SDK requires real per-transition inputs that the compiler doesn't have, and the eager path cannot receive LionDen's guarded query object. LionDen injects sidecar/runtime cache hits, but cache misses synthesize lazily through `pm.execute` so state queries use the guarded network path. See [`research/key-caching.md`](research/key-caching.md) for the full analysis.

## How To Use This Doc

Use this file when you need to answer questions like:

- Why is LionDen source-first?
- Why is Leo v4 the default framework baseline?
- Why does the compiler rely on ABI output?
- Why is devnode the default local workflow?
- Which areas are foundational versus still maturing?

For implementation detail, follow the subsystem links beside each decision above, or pick a doc from the README [Documentation Map](../README.md#documentation-map).
