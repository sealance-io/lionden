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

- Leo v4.1 default; Leo v4.0 remains an explicit compatibility line, and Leo v3.5 deployable-program compatibility is supported with limitations (see [`leo-version-compatibility.md`](leo-version-compatibility.md))
- ABI-driven code generation from `build/abi.json`
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

## Network Dependencies

`compilePipeline()` fetches network dependencies through `defaultFetchNetworkDep()`, which requests deployed program source from node REST endpoints using `GET /{network}/program/{programId}`. Cached network dependencies are stored under the artifacts cache area and reused when available for the same effective network and endpoint. If a deployed dependency changes at the same endpoint, run `lionden compile --force` to fetch and relink it.

When the default network is:

- `http`: LionDen uses the configured endpoint
- `devnode`: LionDen derives `http://<socketAddr>`

The network segment in the URL is driven by the `networkHint` on the dependency (typically `"testnet"`). When no hint is configured, `defaultFetchNetworkDep()` tries `testnet`, `mainnet`, and `canary` in order and uses the first successful response.

### Effective-network override

`compilePipeline()` resolves the endpoint, `networkHint`, and `.env` from `config.defaultNetwork` by default. `CompileOptions.network` overrides this: when set, the network-dependency fetch (`GET /{network}/program/{id}`) and `.env` materialization use `config.networks[network]` instead. This is an **internal override**, not a CLI flag — `--network` is a reserved built-in global that mutates `config.defaultNetwork`. It is threaded through programmatic `tasks.run("deploy"/"recipe"/"upgrade", { network })` so the implicit compile fetches imported on-chain sources from the deploying network. An override naming a network absent from `config.networks` throws before any fetch, so an unknown network never silently falls back to `http://127.0.0.1:3030`.

## Caching

Compilation caching is driven by:

- a per-unit content hash
- local dependency hashes
- cache records written under `artifacts/.cache`

`--force` on the compile task bypasses the cache.

## ABI and Generated Bindings

For program units, the compiler reads either legacy `build/abi.json` or Leo 4.1 per-unit `build/<unit>/abi.json`, parses it, and stores the ABI in the LRE artifact store. Compiled outputs are normalized back to `artifacts/<programId>/abi.json` and `artifacts/<programId>/main.aleo` for downstream deploy, upgrade, dependency linking, and key-cache identity.

The ABI is the contract between Leo compilation and TypeScript code generation. That avoids regex-based parsing of generated Aleo source and keeps wrapper generation aligned with the compiler's structured output.

Leo 4.1 ABI extensions are parsed conservatively: `views` and `implements` are preserved for compatibility checks and ABI hashes when present, but generated wrappers do not expose view-query methods yet. Executable functions with non-empty `const_parameters` fail codegen with an explicit unsupported-feature error.

Generated bindings are the preferred user-facing API when the ABI is known. They encode ABI shape, Leo value serialization, visibility, encrypted output handles, and record helpers in TypeScript. Raw string execution remains available as an escape hatch for dynamic ABI situations, post-upgrade calls, or cases where the generated wrapper cannot yet model the call.

### Scalar inputs (field / scalar / group)

Transition arguments and mapping keys typed `field`, `scalar`, or `group` accept either a branded value from `Leo.field(...)` / `Leo.scalar(...)` / `Leo.group(...)` or a bare non-negative integer — `bigint` or `number` — which is auto-suffixed during serialization. So `pool_id: 1n` and `pool_id: Leo.field(1n)` are equivalent, and the same widening applies to the `Leo.*` constructors themselves, which now take `bigint | number | string`.

Validation rules:

- Values must be non-negative integers. A `number` above `2^53 - 1` is rejected (it cannot be represented exactly) — pass a `bigint` or string for large field values.
- String inputs accept a bare-numeric form (`"12"`, auto-suffixed) or an already-suffixed literal (`"12field"`); visibility-suffixed strings (`"12field.public"`) are rejected on the input path. `group` is limited to integer literals.

Type-safety tradeoff: branded values (`LeoField`, etc.) remain cross-type checked — a `LeoField` is not assignable where a `GroupInput` or `AddressInput` is expected. Bare numerics, however, are interchangeable across the three scalar slots (consistent with how integer inputs already work). Outputs and stored values stay branded, so reads remain strongly typed. Pass `Leo.field(...)` explicitly when you want the stricter cross-type guarantee at a call site.

### Composite inputs (structs / records)

Struct and record types are emitted as two interfaces: a branded `Name` (used for
outputs — return values, mapping values, decrypted records, storage reads) and a
widened `NameInput` (used for inputs — transition arguments, mapping keys, and the
serializer signature). `NameInput` types every field through the input binding, so
scalar fields accept `bigint | number`, address fields accept `AddressInput`, and
nested arrays/structs/records widen recursively. A `MerkleProof` with
`siblings: field[]` can therefore be passed as a plain literal:

```ts
await amm.add_liquidity.locally({
  pool_id: 1n,
  token_1_merkle_proof: [{ siblings: [1n, 2n], leaf_index: 0 }], // no per-element Leo.field(...)
  // …
});
```

Because every input field is a superset of its branded output (`AddressInput ⊇
LeoAddress`, `FieldInput ⊇ LeoField`, `GroupInput ⊇ LeoGroup`), a record read or
decrypted from chain (branded `Token`) re-spends back into an input slot with no
conversion — pass the value straight through. Reads stay branded, so reading a
returned struct/record or a mapping value is still strongly typed.

For cross-program references, the consuming wrapper emits a local alias
`type Producer_TypeInput = WidenInput<Producer_Type>` (defined in `BaseContract.ts`)
rather than importing a separate input interface — no extra cross-program import is
needed.

Address caveat: `AddressInput` is `LeoAddress | { readonly address: string }`. A
record `owner` or an address-typed field accepts a wrapper object (`{ address:
"aleo1…" }`) or `Leo.address("aleo1…")`, but not a bare `aleo1…` string — wrap it.

Each generated wrapper factory accepts a `BaseContractOptions` argument:

```ts
const governance = createGovernance({
  imports: ["voting_power.aleo", "quadratic_power.aleo"],
});
```

Every wrapper exposes the owning program identity through `contract.programId`
and derives the deterministic Aleo program address with `contract.address()`.
The address is computed from the program id, so it is available before
deployment and is not a deployment-state record.

`imports` carries runtime imports that the wrapper attaches to every transition call — useful for dispatch hubs that need the same set of dynamic targets on each call. The same option also appears on `BaseCallOptions` as a per-call additive layer, and `withSigner()` clones preserve the instance-level list. See [`network.md` § Runtime Imports For Dynamic Dispatch](network.md#runtime-imports-for-dynamic-dispatch) for the full layered model.

`codegen.dynamicRecords` can emit conversion helpers for Leo v4 `dyn record` interface inputs when the concrete source record ABI is known:

```ts
export default defineConfig({
  codegen: {
    dynamicRecords: {
      asGoldToken: {
        sourceProgram: "gold_token.aleo",
        sourceRecord: "Token",
        schema: {
          owner: "address.private",
          amount: "u64.private",
          purity: "u64.private",
          _nonce: "group.public",
        },
      },
    },
  },
});
```

The helper is emitted from the source program's generated module and wraps `Leo.dynamicRecord(...)` with the configured schema. Use this when a generated concrete record, such as `gold_token.aleo::Token`, must be passed to a shared `dyn record` interface. See [`json-abi.md` § Interface Conversion Helpers](json-abi.md#interface-conversion-helpers-codegendynamicrecords) and `examples/aleo-ports/dynamic_records`.

`@lionden/plugin-leo` then generates TypeScript output when codegen is enabled:

- `BaseContract.ts`
- one generated wrapper per compiled program
- `index.ts` barrel export

Generated files are written under `config.paths.typechain`.

### Mapping accessors

Each program mapping is emitted under a per-contract `mappings` namespace, keyed by the
mapping's camelCased name (`lp_vouchers` → `mappings.lpVouchers`). When two names collide
after camelCasing, every member of the collision group falls back to its original Leo name
as a quoted key. The on-chain query always uses the original Leo name regardless of the
emitted property key.

Each entry mirrors Leo's read operations and reuses the same key/value
(de)serialization expression generators as transition codegen:

- `contains(key): Promise<boolean>` — like Leo `contains`.
- `get(key): Promise<Value>` — like Leo `get`; non-nullable, throws `MappingKeyNotFoundError`
  when the key is absent.
- `getOrUse(key, def): Promise<Value>` — like Leo `get_or_use`.
- `tryGet(key): Promise<Value | null>` — returns `null` when the key is absent.

`MappingKeyNotFoundError` is part of the `LionDenTypechainError` hierarchy defined in the
generated `BaseContract.ts`; consumers import it from their generated `typechain/index.ts`.

#### Option-valued mappings

When the value type is `Option<T>`, key presence and value-nullness are independent
axes: a present-but-`None` entry is stored on-chain as a `{ is_some: false, … }` struct,
so it is a real entry that the deserializer resolves to `null`. This produces three
distinguishable states:

| State | `contains` | `tryGet` | `get` | `getOrUse(key, d)` |
|-------|-----------|----------|-------|--------------------|
| key absent | `false` | `null` | throws `MappingKeyNotFoundError` | `d` |
| present, `None` | `true` | `null` | `null` | `null` |
| present, `Some(x)` | `true` | `x` | `x` | `x` |

`tryGet` returns `null` for both *key absent* and *stored `None`* — it cannot tell them
apart. Only `contains` reports the presence axis. To distinguish the two, check
presence first, then read:

```ts
if (await c.mappings.maybeScore.contains(key)) {
  const value = await c.mappings.maybeScore.get(key); // present ⇒ null means stored None
}
```

### Storage accessors

Each ABI storage variable is emitted under a separate per-contract `storage` namespace,
keyed by the variable's camelCased name. Storage variables are not modeled as mappings,
so their accessors do not accept a key:

- `get(): Promise<Value>` — returns the deserialized value and throws
  `StorageValueNotFoundError` when the value is absent.
- `getOrUse(def): Promise<Value>` — returns `def` when the value is absent.
- `tryGet(): Promise<Value | null>` — returns `null` when the value is absent.

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

The compiler treats `artifacts/<programId>/` as compiler-owned output and recreates it on each successful compile of that program. Deployment state and caches live outside that directory.

Deploy state is tracked separately by the deploy plugin.

The key-artifact sidecar uses `format: "lionden.keyArtifacts.v1"` and records the program id, compiled source hash, a compiler-side import hash over the materialized package `imports/` directory, and optional per-transition `.prover` / `.verifier` refs when Leo emits files that can be paired unambiguously. The sidecar import hash currently represents materialized network dependency sources; local program dependencies are resolved by Leo through `program.json` dependency paths and are not staged into that `imports/` directory. Compile-time proving-key synthesis is intentionally deferred — see [`research/key-caching.md`](research/key-caching.md) for the design rationale, the sidecar/runtime `importsHash` distinction, and the SDK gap that would unblock pre-warm.

## Design Direction

For the broader rationale behind source-first compilation, ABI-driven wrappers, and the Leo v4 baseline, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the current compiler package for actual behavior in this repo.
