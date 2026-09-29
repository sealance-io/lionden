# Compiler

When to read this: use this file for Leo source discovery, dependency resolution, package materialization, compilation, artifact output, and the handoff to TypeScript binding generation; generated-client behavior and `codegen.*` configuration are in [`typechain.md`](typechain.md).

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

- Leo 4.4.x is the default line, specifically 4.4.2; Leo 4.3.x, 4.2.x, 4.1.x, 4.0.x, and 3.5.x remain supported compatibility lines with limitations (see [`leo-version-compatibility.md`](leo-version-compatibility.md))
- ABI-driven code generation from the compiler's `abi.json`
- source-first project layout under `programs/`
- Leo libraries via `lib.leo` as compile-time dependencies rather than deployable programs

This is the core reason LionDen materializes temporary Leo packages instead of asking users to maintain Leo CLI package structure directly in source control.

## Source Discovery

`packages/leo-compiler/src/source-discovery.ts` treats the `programs/` tree as source-first input.

Current discovery rules:

- a directory containing `main.leo` is a program root
- the program root directory name must match the declared `program <name>.aleo`
  name in `main.leo`; mismatches fail source discovery early
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

Deploy rename is handled inside this materialization step rather than by
depending on a Leo CLI build flag. A deploy-triggered compile can provide
`program` as the source selector and `rename` as the target runtime id; the
materializer rewrites only the selected primary program's `main.leo`
declaration and `program.json` program field to the target id. Dependency
declarations and imports are left untouched.

## Network Dependencies

`compilePipeline()` fetches network dependencies through `defaultFetchNetworkDep()`, which requests deployed program source from node REST endpoints using `GET /{network}/program/{programId}`. Cached network dependencies are stored under the artifacts cache area and reused when available for the same effective network and endpoint. If a deployed dependency changes at the same endpoint, run `lionden compile --force` to fetch and relink it.

When the default network is:

- `http`: LionDen uses the configured endpoint
- `devnode`: LionDen derives `http://<socketAddr>`

The network segment in the URL comes from the effective network config's `network` field (devnode networks default to `testnet`; `http` networks must set it), passed to the fetcher as `networkHint`. [`defaultFetchNetworkDep()`](../packages/leo-compiler/src/compiler.ts) falls back across `testnet`, `mainnet`, and `canary`, using the first successful response, only when no hint is available, such as a direct programmatic call that omits it. Fallback also applies when the resolved network entry has no `network` value.

### Effective-network override

`compilePipeline()` resolves the endpoint, `networkHint`, and `.env` from `config.defaultNetwork` by default. `CompileOptions.network` overrides this: when set, the network-dependency fetch (`GET /{network}/program/{id}`) and `.env` materialization use `config.networks[network]` instead. This is an **internal override**, not a CLI flag — `--network` is a reserved built-in global that mutates `config.defaultNetwork`. It is threaded through programmatic `tasks.run("deploy"/"recipe"/"upgrade", { network })` so the implicit compile fetches imported on-chain sources from the deploying network. An override naming a network absent from `config.networks` throws before any fetch, so an unknown network never silently falls back to `http://127.0.0.1:3030`.

## Caching

Compilation caching is driven by:

- a per-unit content hash
- local dependency hashes
- cache records written under `artifacts/.cache`

`--force` on the compile task bypasses the cache.

Renamed deploy builds are cached separately from non-renamed builds. The source
program id continues to drive local discovery and dependency resolution, while
the effective runtime program id drives the materialized build-unit directory,
normalized artifact directory, ABI program id, key-artifact metadata, and
runtime artifact lookup.

## ABI and Generated Bindings

For program units, the compiler locates `abi.json` through `resolveBuildArtifacts()` — legacy `build/abi.json`, Leo 4.1 per-unit `build/<unit>/abi.json`, or the Leo 4.2+ single-program `build/<program>/abi.json` — parses it, and stores the ABI in the LRE artifact store. Compiled outputs are normalized back to `artifacts/<programId>/abi.json` and `artifacts/<programId>/main.aleo` for downstream deploy, upgrade, dependency linking, and key-cache identity.

The ABI is the contract between Leo compilation and TypeScript code generation. That avoids regex-based parsing of generated Aleo source and keeps wrapper generation aligned with the compiler's structured output.

Leo 4.1 ABI extensions are parsed conservatively: `views` and `implements` are preserved on the parsed ABI and included in `computeAbiHash()` when present. Generated wrappers expose ABI views under `contract.views.<name>(...args)`. Executable functions or views with non-empty `const_parameters` fail codegen with an explicit unsupported-feature error.

Generated-client behavior and all [`codegen.*` configuration](typechain.md#codegen-configuration) are documented in [`typechain.md`](typechain.md):

- [View functions](typechain.md#view-functions)
- [Scalar inputs (field / scalar / group)](typechain.md#scalar-inputs-field--scalar--group)
- [Composite inputs (structs / records)](typechain.md#composite-inputs-structs--records)
- [Wrapper options and program identity](typechain.md#wrapper-options-and-program-identity)
- [Dynamic-record helper configuration (`codegen.dynamicRecords`)](typechain.md#dynamic-record-helper-configuration)
- [Generated files](typechain.md#generated-files): `BaseContract.ts` plus one wrapper per compiled program, written under `config.paths.typechain` when codegen is enabled
- [Mapping accessors](typechain.md#mapping-accessors)
- [Option-valued mappings](typechain.md#option-valued-mappings)
- [Storage accessors](typechain.md#storage-accessors)

Copied or reconstructed records (object spread, `structuredClone`, JSON round-trips) lose the non-enumerable raw metadata that dynamic-record helpers preserve; see [`typechain.md` § Interface conversion helpers](typechain.md#interface-conversion-helpers).

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
- `interfaces/` (per-interface JSON such as `TokenStandard.json`) when Leo emits interface definitions for the program
- `lionden-key-artifacts.json`

The compiler treats `artifacts/<programId>/` as compiler-owned output and recreates it on each successful compile of that program. Deployment state and caches live outside that directory.

Deploy state is tracked separately by the deploy plugin.

The key-artifact sidecar uses `format: "lionden.keyArtifacts.v1"` and records both the runtime `programId` and canonical local `sourceProgramId`, plus the compiled source hash, a compiler-side import hash over the materialized package `imports/` directory, and optional per-transition `.prover` / `.verifier` refs when Leo emits files that can be paired unambiguously. The sidecar import hash currently represents materialized network dependency sources; local program dependencies are resolved by Leo through `program.json` dependency paths and are not staged into that `imports/` directory. Compile-time proving-key synthesis is intentionally deferred — see [`research/key-caching.md`](research/key-caching.md) for the design rationale, the sidecar/runtime `importsHash` distinction, and the SDK gap that would unblock pre-warm.

## Design Direction

For the broader rationale behind source-first compilation, ABI-driven wrappers, and the Leo v4 baseline, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the current compiler package for actual behavior in this repo.
