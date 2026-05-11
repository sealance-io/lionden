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

## Product Direction

The target shape of LionDen is:

- ESM-native TypeScript monorepo
- Hardhat-style plugin, hook, and task architecture
- devnode-first local development
- source-first Leo project layout under `programs/`
- ABI-driven TypeScript bindings
- Vitest-based test workflows
- Leo v4 as the default line, with scoped Leo v3.5 deployable-program compatibility documented separately

Those principles are broader than the current implementation and should be read as design direction rather than a claim that every interface is already complete.

## Key Design Decisions

The major decisions preserved from the original planning material are:

1. ESM-native package and runtime model.
2. Lazy loading where possible to keep CLI startup cheap.
3. Devnode-first local workflows, with `http` for connecting to external networks.
4. ABI-driven code generation rather than regex-driven parsing of generated Aleo source.
5. Support for local-style and on-chain-style execution flows in generated and runtime tooling.
6. Vitest as the test runner instead of a custom LionDen-owned framework.
7. Leo v4 is the primary baseline; Leo v3.5 support is intentionally scoped to deployable `main.leo` programs and compatibility workflows, not full library support.
8. Source-first authoring in `programs/`, with LionDen materializing compiler-friendly package layouts internally.
9. A Hardhat-like declarative plugin surface with config lifecycle hooks and task composition.
10. A Provable SDK baseline aligned with devnode-aware APIs.
11. A small external dependency surface. `@provablehq/sdk` and its transitive dependencies are the deliberate heavyweight exception; other third-party runtime dependencies should be rare, justified by clear framework value, and isolated behind narrow package boundaries.

## Platform Baseline

Several platform facts are important when working on LionDen:

- Leo v4 changed core language and tooling assumptions, including unified `fn` syntax and library support via `lib.leo`.
- `leo devnode` is the primary lightweight local-development target.
- Users who need a multi-validator network can run snarkOS externally and connect via `http`.
- `leo build` produces structured JSON ABI output that LionDen treats as the source of truth for wrapper generation.
- Upgradability depends on constructor behavior and compatibility constraints, so deployment tooling must understand constructor metadata and persisted deploy state.

These assumptions explain many of the repo's current package boundaries and task names.

## Roadmap Shape

The implementation work is organized conceptually in these layers:

1. Foundation: config, core plugin model, task system, CLI boot flow.
2. Compilation: source discovery, dependency resolution, temporary package materialization, `leo build`, ABI parsing, code generation.
3. Network abstraction: devnode/HTTP connections, runtime network manager, `node` and `run`.
4. Deployment: deploy, upgrade, export, constructor enforcement, and deployment state.
5. Testing: managed devnode lifecycle, reusable test context, fixtures, assertions, Vitest integration.
6. Scaffolding and examples: `create-lionden`, starter templates, example projects.

This roadmap is useful for understanding intent and package boundaries even when current implementation depth varies by area.

## Known Challenges

The most important engineering constraints preserved from the original design work are:

- SDK compatibility matters. The network layer expects a modern `@provablehq/sdk` surface with devnode-aware functionality.
- SDK initialization is nontrivial and should stay isolated in adapter code.
- Proof generation is slow enough that long test timeouts are normal.
- Test isolation relies on fresh devnode lifecycle and fixture patterns rather than snapshot/revert semantics.
- Network dependency fetching depends on reachable endpoints and local caching.
- Package materialization must preserve nested source layout, or Leo imports break.
- Leo libraries and deployable programs must be treated differently in compile, codegen, and deploy flows.
- Upgradeability and constructor enforcement are part of the deployment contract, not optional metadata.

## How To Use This Doc

Use this file when you need to answer questions like:

- Why is LionDen source-first?
- Why is Leo v4 the default framework baseline?
- Why does the compiler rely on ABI output?
- Why is devnode the default local workflow?
- Which areas are foundational versus still maturing?

For implementation detail, switch back to the focused subsystem docs:

- [`project-layout.md`](project-layout.md)
- [`architecture.md`](architecture.md)
- [`compiler.md`](compiler.md)
- [`network.md`](network.md)
- [`deployment.md`](deployment.md)
- [`testing.md`](testing.md)
- [`leo-version-compatibility.md`](leo-version-compatibility.md)
