# Compiler

When to read this: use this file for Leo source discovery, dependency resolution, package materialization, compilation, artifact output, and TypeScript binding generation.

## Current Compile Pipeline

The main entrypoint is `compilePipeline()` in `packages/leo-compiler/src/compiler.ts`.

The current pipeline is:

1. discover compilation units under `config.paths.programs`
2. resolve dependencies and topological order
3. materialize temporary Leo packages under the artifacts build area
4. fetch and link network dependencies as needed
5. compile units in dependency order with `leo build`
6. parse ABI for programs
7. copy final program artifacts into `artifacts/<programId>/`

`@lionden/plugin-leo` exposes this through the `compile` task.

## Platform Baseline

The compiler and generated bindings assume a specific Leo-era baseline:

- Leo v4 default; Leo v3.5 deployable-program compatibility is supported with limitations (see [`leo-version-compatibility.md`](leo-version-compatibility.md))
- ABI-driven code generation from `build/abi.json`
- source-first project layout under `programs/`
- Leo libraries via `lib.leo` as compile-time dependencies rather than deployable programs

This is the core reason LionDen materializes temporary Leo packages instead of asking users to maintain Leo CLI package structure directly in source control.

## Source Discovery

`packages/leo-compiler/src/source-discovery.ts` treats the `programs/` tree as source-first input.

Current discovery rules:

- a directory containing `main.leo` is a program root
- a directory containing `lib.leo` is a library root
- once a root is found, its subtree is collected as source files and not scanned for nested roots
- program IDs are extracted from `program <name>.aleo { ... }` in `main.leo`
- all `.leo` files beneath the root are preserved as part of the unit

This lets users keep nested helper files under a program directory without manually maintaining a Leo package layout in source control.

## Dependency Resolution

Dependency resolution is handled by `packages/leo-compiler/src/dependency-resolver.ts`.

At a high level, the compiler distinguishes:

- local program or library dependencies
- network dependencies fetched from an endpoint

The resolved graph is used both for compile order and for downstream deploy ordering.

## Package Materialization

`packages/leo-compiler/src/package-materializer.ts` turns discovered units into temporary Leo packages under the artifacts area.

The materialized package contains the pieces that `leo build` expects, including:

- `src/` with the original source tree preserved
- generated package metadata
- linked imports
- `build/` output after compilation

This keeps the repo source layout ergonomic while still using the Leo CLI as the compiler of record.

## Network Dependencies

`compilePipeline()` fetches network dependencies through `defaultFetchNetworkDep()`, which requests deployed program source from node REST endpoints using `GET /{network}/program/{programId}`. Cached network dependencies are stored under the artifacts cache area and reused when available.

When the default network is:

- `http`: LionDen uses the configured endpoint
- `devnode`: LionDen derives `http://<socketAddr>`

The network segment in the URL is driven by the `networkHint` on the dependency (typically `"testnet"`). When no hint is configured, `defaultFetchNetworkDep()` tries `testnet`, `mainnet`, and `canary` in order and uses the first successful response.

## Caching

Compilation caching is driven by:

- a per-unit content hash
- local dependency hashes
- cache records written under `artifacts/.cache`

`--force` on the compile task bypasses the cache.

## ABI and Generated Bindings

For program units, the compiler reads `build/abi.json`, parses it, and stores the ABI in the LRE artifact store.

The ABI is the contract between Leo compilation and TypeScript code generation. That avoids regex-based parsing of generated Aleo source and keeps wrapper generation aligned with the compiler's structured output.

Generated bindings are the preferred user-facing API when the ABI is known. They encode ABI shape, Leo value serialization, visibility, encrypted output handles, and record helpers in TypeScript. Raw string execution remains available as an escape hatch for dynamic ABI situations, post-upgrade calls, or cases where the generated wrapper cannot yet model the call.

`@lionden/plugin-leo` then generates TypeScript output when codegen is enabled:

- `BaseContract.ts`
- one generated wrapper per compiled program
- `index.ts` barrel export

Generated files are written under `config.paths.typechain`.

## `compile` and `clean`

`packages/plugin-leo/src/index.ts` currently exposes:

- `compile`
  - `--force`
  - `--no-typechain`
  - `--program <name>`
- `clean`
  - removes the artifacts and typechain directories

The compile task also populates the in-memory artifact store in the LRE so later tasks such as deploy can read ABIs and compiled source.

## Artifact Output

Current program artifact output is copied into `artifacts/<programId>/` and includes:

- `abi.json`
- `main.aleo`
- generated prover files when present
- generated verifier files when present
- `lionden-key-artifacts.json`

Deploy state is tracked separately by the deploy plugin.

The key-artifact sidecar uses `format: "lionden.keyArtifacts.v1"` and records the program id, compiled source hash, import hash, and optional per-transition `.prover` / `.verifier` refs when Leo emits files that can be paired unambiguously. The compiler does not synthesize proving keys during `compile`; with Leo versions that emit no key files, the sidecar is identity-only and runtime filesystem caching remains lazy.

## Design Direction

For the broader rationale behind source-first compilation, ABI-driven wrappers, and the Leo v4 baseline, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the current compiler package for actual behavior in this repo.
