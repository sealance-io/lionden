# JSON ABI

When to read this: use this file for the Leo compiler's JSON ABI schema, type serialization rules, CLI generation, and the differences between compiler output and LionDen's normalized TypeScript types.

## Overview

The Leo compiler produces a JSON ABI (Application Binary Interface) file that describes the public interface of a compiled Leo/Aleo program. It enumerates every struct, record, mapping, storage variable, and function that the program exposes, along with their full type signatures.

LionDen consumes the ABI for three purposes:

1. **TypeScript code generation** — `packages/leo-compiler/src/codegen/` produces typed bindings from ABI data.
2. **Upgrade compatibility checks** — `packages/plugin-deploy/src/abi-compat.ts` enforces ARC-0006 upgrade rules by diffing old and new ABIs.
3. **Artifact management** — the ABI is copied to `artifacts/<programId>/abi.json` and stored in the LRE artifact store.

The authoritative type definitions live in the Leo compiler's Rust source at `crates/abi-types/src/lib.rs`. All types derive `serde::Serialize` and `serde::Deserialize`, so the JSON schema is a direct serde serialization of those Rust types.

## Top-Level Schema

The root object is a `Program`:

| Field | Type | Description |
|---|---|---|
| `program` | `string` | Program identifier (e.g. `"token.aleo"`) |
| `structs` | `Struct[]` | Struct type definitions |
| `records` | `Record[]` | Record type definitions |
| `mappings` | `Mapping[]` | On-chain key-value storage declarations |
| `storage_variables` | `StorageVariable[]` | Storage variable declarations |
| `functions` | `Function[]` | Public entry points (compiled to Aleo transitions) |

All array fields are present even when empty.

Minimal example:

```json
{
  "program": "hello.aleo",
  "structs": [],
  "records": [],
  "mappings": [],
  "storage_variables": [],
  "functions": [
    {
      "name": "main",
      "is_final": false,
      "inputs": [
        { "name": "a", "ty": { "Plaintext": { "Primitive": { "UInt": "U32" } } }, "mode": "None" },
        { "name": "b", "ty": { "Plaintext": { "Primitive": { "UInt": "U32" } } }, "mode": "None" }
      ],
      "outputs": [
        { "ty": { "Plaintext": { "Primitive": { "UInt": "U32" } } }, "mode": "None" }
      ]
    }
  ]
}
```

## Primitive Types

The `Primitive` enum covers all Aleo literal types:

| Variant | JSON serialization |
|---|---|
| `Address` | `"Address"` |
| `Boolean` | `"Boolean"` |
| `Field` | `"Field"` |
| `Group` | `"Group"` |
| `Identifier` | `"Identifier"` |
| `Scalar` | `"Scalar"` |
| `Signature` | `"Signature"` |
| `UInt(size)` | `{ "UInt": "U8" \| "U16" \| "U32" \| "U64" \| "U128" }` |
| `Int(size)` | `{ "Int": "I8" \| "I16" \| "I32" \| "I64" \| "I128" }` |

Simple variants serialize as bare strings. Wrapper variants serialize as single-key objects.

```json
{ "Primitive": "Address" }
{ "Primitive": "Boolean" }
{ "Primitive": { "UInt": "U64" } }
{ "Primitive": { "Int": "I32" } }
```

Leo identifier values are represented as single-quoted literals on the wire, for example `'voting_power'`. Generated TypeScript bindings keep identifiers branded: outputs use `LeoIdentifier`, inputs use `IdentifierInput` (`LeoIdentifier`), and callers pass `Leo.identifier("voting_power")` rather than a bare string. The runtime serializer still normalizes bare or already quoted identifier text to the quoted wire form, and outputs parse back to a branded bare name.

## Plaintext Types

`Plaintext` represents any non-encrypted type. Used for struct fields, record fields, mapping keys/values, and storage variables.

| Variant | JSON shape | Description |
|---|---|---|
| `Primitive` | `{ "Primitive": ... }` | A primitive type |
| `Array` | `{ "Array": { "element": ..., "length": n } }` | Fixed-length array |
| `Struct` | `{ "Struct": { "path": [...], "program": ... } }` | Reference to a struct type |
| `Optional` | `{ "Optional": ... }` | Optional type (`T?` in Leo) |

### Array

```json
{
  "Array": {
    "element": { "Primitive": { "UInt": "U32" } },
    "length": 4
  }
}
```

Nested arrays are supported — the `element` field is itself a `Plaintext`.

### StructRef

A reference to a struct type, potentially from another program:

| Field | Type | Description |
|---|---|---|
| `path` | `string[]` | Path segments to the struct (e.g. `["Point"]` or `["utils", "Vector3"]` for module-scoped types) |
| `program` | `string \| null` | The program containing this struct, if external. `null` for local structs. |

```json
{ "Struct": { "path": ["TokenInfo"], "program": null } }
{ "Struct": { "path": ["utils", "Vector3"], "program": "math_lib.aleo" } }
```

### Optional

Wraps a `Plaintext` type. In Leo source this is `T?`. In compiled Aleo bytecode, `T?` lowers to a struct `struct "T?" { is_some: bool, val: T }`.

```json
{ "Optional": { "Primitive": { "UInt": "U64" } } }
```

## Structs

Structs are custom composite types defined at the global scope (outside `program {}`).

| Field | Type | Description |
|---|---|---|
| `path` | `string[]` | Path to the struct. Single-element for top-level, multi-element for module-scoped. |
| `fields` | `StructField[]` | Ordered list of fields |

Each `StructField`:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Field name |
| `ty` | `Plaintext` | Field type |

```json
{
  "path": ["TokenInfo"],
  "fields": [
    { "name": "supply", "ty": { "Primitive": { "UInt": "U64" } } },
    { "name": "admin", "ty": { "Primitive": "Address" } }
  ]
}
```

## Records

Records are private data structures declared inside `program {}`. Every record has an implicit `owner: address` field. In Aleo, records also carry `_nonce` and `_version` components that do not appear in the ABI.

| Field | Type | Description |
|---|---|---|
| `path` | `string[]` | Path to the record |
| `fields` | `RecordField[]` | Ordered list of fields (includes the explicit `owner` field) |

Each `RecordField`:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Field name |
| `ty` | `Plaintext` | Field type |
| `mode` | `Mode` | Visibility mode for this field |

```json
{
  "path": ["Token"],
  "fields": [
    { "name": "owner", "ty": { "Primitive": "Address" }, "mode": "None" },
    { "name": "amount", "ty": { "Primitive": { "UInt": "U64" } }, "mode": "None" }
  ]
}
```

### Generated Record Helpers

For every record in the ABI, codegen emits three helpers (plus the interface):

- `serialize<Name>(value, ctx?): string` — JS object → Leo literal. Round-trips losslessly via the `BaseContract.RECORD_RAW` symbol cache so visibility-suffixed records survive re-input.
- `deserialize<Name>(value): <Name>` — Leo literal → typed JS object. Stashes the raw literal on `RECORD_RAW` for future re-serialization.
- `async decrypt<Name>(ciphertext, key): Promise<<Name>>` — `record1...` ciphertext + decryption key → typed JS object. Internally delegates to `BaseContract.decryptRecord` which awaits `@lionden/network`'s SDK-load and runs `deserialize<Name>` over the plaintext; RECORD_RAW is preserved through this path too.

Imported records (records declared in another program) reuse the originating program's generated helpers — no duplicate emission. See `docs/testing.md` for the decrypt key API and `SettledTransition.rawOutputs` transition-identity contract.

### Interface Conversion Helpers (`codegen.dynamicRecords`)

Programs that consume Leo v4 `dyn record` inputs through a shared interface (e.g. `compliant_amm` accepting any `Token`-shaped record) need a single-line conversion at every call site. Codegen can emit those helpers from a project-wide config map keyed by helper name:

```ts
// lionden.config.ts
export default defineConfig({
  codegen: {
    dynamicRecords: {
      asPoolToken: {
        sourceRecord: "Token",
        // Optional. Required only when multiple compiled programs declare a
        // record with the generated name "Token".
        sourceProgram: "stable_token.aleo",
        schema: {
          owner: "address.private",
          amount: "u128.private",
          _version: "u8.public",
          _nonce: "group.public",
        },
      },
    },
  },
});
```

The emitted helper lives alongside `decrypt<Name>` in the source program's generated module, using a callable+namespace pattern (`Object.assign`) so the helper is both a function and a namespace carrying the output-side `.output` matcher:

```ts
// typechain/StableToken.ts (generated)
function _asPoolTokenImpl(value: Token): LeoDynamicRecord {
  return Leo.dynamicRecord(value, {
    owner: "address.private" as const,
    amount: "u128.private" as const,
    _version: "u8.public" as const,
    _nonce: "group.public" as const,
  } as const);
}
export const asPoolToken = Object.assign(_asPoolTokenImpl, {
  output: createRecordOutputMatcher<Token>({
    program: "stable_token.aleo",
    recordName: "Token",
    deserialize: deserializeToken,
  }),
});
```

Callers import `asPoolToken` directly for input conversion:

```ts
await amm.add_liquidity.locally({ token: asPoolToken(tok), ... });
```

The same helper is the preferred output-side matcher when the dispatched call returns a `dyn record` handle:

```ts
const accepted = await amm.route_transfer.accepted({
  token: asPoolToken(tok),
  to,
});

const recovered = await accepted.outputs
  .match(asPoolToken.output.from("transfer", 0))
  .decrypt(to);
```

**`.output`** is a `RecordOutputMatcher<T>` carrying the program id, source record name, the matching deserializer, and `.from(...)` / `.at(...)` builders that bind a transition source. It feeds every record-output arm:

- `IdOnlyExternalRecordHandle<T>.match(matcher.from(name, idx)).decrypt(key)` — selects the callee transition that emitted the external `Record` and decrypts via the matcher.
- `IdOnlyDynamicRecordHandle.match(matcher.from(name, idx)).decrypt(key)` — selects an explicit sibling concrete output materialized by a V15-compliant callee (does **not** dereference the dynamic-record id).
- `EncryptedRecord<T>.match(matcher).decrypt(key)` — re-routes decryption through the matcher's deserializer, with an identity guard requiring `matcher.program` / `matcher.recordName` to equal the ciphertext's metadata.

Prefer named `.from(...)` in application code because the matcher's `program` is inherited as the source `programId`; use `.from(..., { match: n })` when the same transition appears multiple times. `.at(...)` is the positional escape hatch for awkward callgraphs and tests. `.match` is a pure builder; all resolution + identity checks + decryption are deferred to `.decrypt(key)`. See [`network.md` § Id-only record outputs](network.md#id-only-record-outputs-dyn-record-and-external-record) for the client-side flow and [`research/dynamic-records-v15.md`](research/dynamic-records-v15.md) for the V15 record-existence materialization model that makes sibling concrete outputs available in compliant programs.

**Cross-program external records** also emit a sibling `<ExternalRecord>.output` value binding alongside the imported type. For example, an `external_token_demo.aleo` typechain that imports `gold_token.aleo::Token` produces both the type alias `GoldToken_Token` and a value `GoldToken_Token.output: RecordOutputMatcher<GoldToken_Token>` — no `codegen.dynamicRecords` entry required for cross-program record decryption.

For programs with **unresolved external types** (the referenced ABI isn't available at codegen time), the typechain falls back to `IdOnlyExternalRecordHandle<LeoDynamicRecord>` and emits no typed helper. Callers construct a matcher inline via the public `createRecordOutputMatcher<MyShape>({ program, recordName, deserialize })` factory and chain `.from` or `.at` as usual.

**Naming**: `sourceRecord` must match the generated TS record type name (`pathToTsName(record.path)`). For module-scoped records, that's the joined PascalCase form, e.g. `Foo_Bar_Token` for `foo::bar::Token`. Set `sourceProgram` when more than one compiled program declares the same generated record name; `examples/aleo-ports/dynamic_records` uses this for `gold_token.aleo::Token` and `silver_token.aleo::Token`.

**Schema rules**:

- Schema keys must exactly match the **generated record shape**: implicit `owner: address`, every ABI field that isn't a re-declaration of `owner`, and implicit `_nonce: group`.
- Schema entry primitives must match each record field's declared type (visibility may differ — that's the point of the helper).
- Supported primitives: `address`, `boolean`, `field`, `group`, `scalar`, `u8`-`u128`, `i8`-`i128`. `Identifier`, `Signature`, struct, array, and optional fields are rejected with `CodegenError` at compile time.

**Validation layers**:

- **Config shape** (plugin-leo `validateUserConfig` hook): non-object map, invalid helper names, non-object helpers, malformed schema entries → aggregated into `ConfigResolutionError`.
- **ABI routing** (plugin-leo compile task): `sourceRecord` does not match a compiled program, ambiguous record name without `sourceProgram`, or `sourceProgram` doesn't declare the record → `CodegenError`.
- **Schema vs generated record** (typescript-generator emit): missing/extra schema keys or primitive-type mismatch → `CodegenError`.

## Mappings

On-chain key-value storage. Declared as `mapping name: KeyType => ValueType` in Leo.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Mapping name |
| `key` | `Plaintext` | Key type |
| `value` | `Plaintext` | Value type |

```json
{
  "name": "balances",
  "key": { "Primitive": "Address" },
  "value": { "Primitive": { "UInt": "U64" } }
}
```

Each mapping produces a `mappings.<camelName>` accessor group in the generated TypeScript
bindings (`contains` / `get` / `getOrUse` / `tryGet`). The ABI schema itself is unchanged —
see [`compiler.md` § Mapping accessors](compiler.md#mapping-accessors).

## Storage Variables

Persistent on-chain state. Leo supports both singleton values (`storage name: Type`) and dynamic lists (`storage name: [Type]`).

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Variable name |
| `ty` | `StorageType` | Storage type |

`StorageType` is an enum:

| Variant | JSON shape | Description |
|---|---|---|
| `Plaintext` | `{ "Plaintext": ... }` | A single plaintext value |
| `Vector` | `{ "Vector": ... }` | A dynamic-length list of a `StorageType` |

Vectors lower to two on-chain mappings at the Aleo level: one for elements indexed by position, one for the length.

```json
{ "name": "admin", "ty": { "Plaintext": { "Primitive": "Address" } } }
```

Storage vector (illustrative):

```json
{ "name": "whitelist", "ty": { "Vector": { "Plaintext": { "Primitive": "Address" } } } }
```

## Functions

Public entry points declared inside `program {}`. Each function compiles to an Aleo `transition`. Functions with `is_final: true` have a finalize block that executes on-chain after the transition.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Function name |
| `is_final` | `boolean` | Whether this function has a finalize block |
| `inputs` | `Input[]` | Ordered list of inputs |
| `outputs` | `Output[]` | Ordered list of outputs |

### Input

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Parameter name |
| `ty` | `FunctionInput` | Input type |
| `mode` | `Mode` | Visibility mode (see below) |

### Output

| Field | Type | Description |
|---|---|---|
| `ty` | `FunctionOutput` | Output type |
| `mode` | `Mode` | Visibility mode (see below) |

### Mode

```
Mode = "None" | "Public" | "Private"
```

`Mode` records the visibility modifier Leo declared on each input or output:

- `"Public"` — explicit `public` modifier; the value travels on chain as a plain Leo literal.
- `"Private"` — explicit `private` modifier.
- `"None"` — **no modifier written; Leo's default applies, which is private**. `"None"` is not a "missing data" marker; it's a real signal meaning "default-to-private".

Lionden codegen consumes `mode` when projecting on-chain transition outputs into the typed `outputs` field of `AcceptedTransition<TOutputs>`. Plaintext outputs with `mode: "Public"` are decoded eagerly to their TS type. Plaintext outputs with `mode: "None"` or `"Private"` come back as Aleo value ciphertexts (`ciphertext1...`) on chain and are wrapped as `EncryptedValue<T>` handles in the typed shape — the caller invokes `outputs.decrypt(key)` to decode them. Record outputs are similarly wrapped as `EncryptedRecord<T>`. See `docs/testing.md` for the typed-broadcast contract.

### FunctionInput

| Variant | JSON shape | Description |
|---|---|---|
| `Plaintext` | `{ "Plaintext": ... }` | A plaintext value |
| `Record` | `{ "Record": { "path": [...], "program": ... } }` | A record reference (see RecordRef below) |
| `DynamicRecord` | `"DynamicRecord"` | Dynamic dispatch — record type resolved at runtime |

### FunctionOutput

| Variant | JSON shape | Description |
|---|---|---|
| `Plaintext` | `{ "Plaintext": ... }` | A plaintext value |
| `Record` | `{ "Record": { "path": [...], "program": ... } }` | A record reference |
| `Final` | `"Final"` | The future handle for on-chain finalization |
| `DynamicRecord` | `"DynamicRecord"` | Dynamic dispatch |

### RecordRef

Used inside `FunctionInput` and `FunctionOutput` to reference a record type:

| Field | Type | Description |
|---|---|---|
| `path` | `string[]` | Path segments to the record |
| `program` | `string \| null` | The program containing this record, if external |

### Examples

Sync function with private inputs:

```json
{
  "name": "multiply",
  "is_final": false,
  "inputs": [
    { "name": "a", "ty": { "Plaintext": { "Primitive": { "UInt": "U32" } } }, "mode": "None" },
    { "name": "b", "ty": { "Plaintext": { "Primitive": { "UInt": "U32" } } }, "mode": "None" }
  ],
  "outputs": [
    { "ty": { "Plaintext": { "Primitive": { "UInt": "U32" } } }, "mode": "None" }
  ]
}
```

Async function with `Final` output and public inputs:

```json
{
  "name": "mint_public",
  "is_final": true,
  "inputs": [
    { "name": "receiver", "ty": { "Plaintext": { "Primitive": "Address" } }, "mode": "Public" },
    { "name": "amount", "ty": { "Plaintext": { "Primitive": { "UInt": "U64" } } }, "mode": "Public" }
  ],
  "outputs": [
    { "ty": "Final", "mode": "None" }
  ]
}
```

Function with record input and output:

```json
{
  "name": "transfer_private",
  "is_final": false,
  "inputs": [
    {
      "name": "token",
      "ty": { "Record": { "path": ["Token"], "program": "token.aleo" } },
      "mode": "None"
    },
    { "name": "receiver", "ty": { "Plaintext": { "Primitive": "Address" } }, "mode": "None" },
    { "name": "amount", "ty": { "Plaintext": { "Primitive": { "UInt": "U64" } } }, "mode": "None" }
  ],
  "outputs": [
    { "ty": { "Record": { "path": ["Token"], "program": "token.aleo" } }, "mode": "None" },
    { "ty": { "Record": { "path": ["Token"], "program": "token.aleo" } }, "mode": "None" }
  ]
}
```

## Mode

Visibility mode for function inputs, function outputs, and record fields.

| Value | Description |
|---|---|
| `"None"` | Default — visibility determined by context (private for transitions, public for finalize) |
| `"Constant"` | Immutable compile-time constant |
| `"Private"` | Kept private off-chain (encrypted in the transaction) |
| `"Public"` | Publicly visible on-chain |

## Serde Serialization Rules

The JSON ABI is produced by Rust's serde with default (externally tagged) enum serialization. Understanding these rules is essential for correctly parsing the JSON.

**Simple enum variants** serialize as bare JSON strings:

```rust
enum Mode { None, Constant, Private, Public }
// → "None", "Constant", "Private", "Public"

enum Primitive { Address, Boolean, ... }
// → "Address", "Boolean"
```

**Newtype enum variants** (wrapping a single value) serialize as single-key objects:

```rust
enum Primitive { UInt(UInt), Int(Int), ... }
// UInt(U64) → { "UInt": "U64" }
// Int(I32) → { "Int": "I32" }

enum Plaintext { Primitive(Primitive), Array(Array), Struct(StructRef), Optional(Optional) }
// Primitive(Address) → { "Primitive": "Address" }
// Array({...})       → { "Array": { "element": ..., "length": 4 } }
```

**Struct enum variants** serialize as single-key objects wrapping a JSON object:

```rust
enum FunctionInput { Record(RecordRef), ... }
// Record(RecordRef { path: ["Token"], program: Some("token.aleo") })
// → { "Record": { "path": ["Token"], "program": "token.aleo" } }
```

**Unit-like variants** in output position serialize as bare strings:

```rust
enum FunctionOutput { Final, DynamicRecord, ... }
// Final → "Final"
// DynamicRecord → "DynamicRecord"
```

**Nesting** produces deeply nested JSON. A `u32` function input traverses three levels:

```
FunctionInput::Plaintext(Plaintext::Primitive(Primitive::UInt(UInt::U32)))
→ { "Plaintext": { "Primitive": { "UInt": "U32" } } }
```

**`Option<T>`** serializes as the value when `Some`, and `null` when `None`:

```rust
struct StructRef { path: Path, program: Option<String> }
// program: Some("token.aleo") → "program": "token.aleo"
// program: None                → "program": null
```

**`Path`** (`Vec<String>`) serializes as a JSON array of strings:

```rust
path: vec!["utils".into(), "Vector3".into()]
// → "path": ["utils", "Vector3"]
```

## CLI Generation

The Leo CLI provides two ways to produce the JSON ABI:

**During build** — `leo build` compiles Leo source and writes `build/abi.json` alongside the compiled Aleo program. This is the primary path used by LionDen's compile pipeline.

**Standalone extraction** — `leo abi <program.aleo>` reads a compiled `.aleo` file and outputs the ABI:

```
leo abi program.aleo                              # print to stdout
leo abi program.aleo --output program_abi.json    # write to file
leo abi program.aleo --network mainnet            # specify network context
```

LionDen reads the ABI from `build/abi.json` in `readProgramAbi()` (`packages/leo-compiler/src/compiler.ts`), parses it with `parseAbi()` (`packages/leo-compiler/src/abi-parser.ts`), and stores it in the LRE artifact store.

## LionDen Normalization

LionDen's TypeScript types (`packages/leo-compiler/src/abi-types.ts`) preserve most of the compiler's type identity while renaming a few top-level fields. The parser (`packages/leo-compiler/src/abi-parser.ts`) bridges both the compiler format and any older normalized format.

| Compiler JSON (this spec) | LionDen TS types | Notes |
|---|---|---|
| `"functions"` array key | `transitions` / `TransitionABI` | Aleo-level naming |
| `"is_final"` | `is_async` | Semantic equivalence — `is_final` means "has finalize block" |
| `"path": ["Token"]` on struct/record definitions | `path: readonly string[]` | Full path preserved — avoids collisions for module-scoped types |
| `{ Struct: { path, program } }` | `{ Struct: StructRef }` | Full identity preserved — `StructRef { path, program }` |
| `{ Record: { path, program } }` | `{ Record: RecordRef }` | Full identity preserved — `RecordRef { path, program }` |
| `"Final"` output | `{ Future: string }` | Remapped variant name |
| `"DynamicRecord"` | `"DynamicRecord"` literal | First-class variant — TS type is `string` (pre-encoded Leo record) |
| `{ Optional: Plaintext }` | `{ Optional: PlaintextType }` | Preserved — serde uses lowered `{ is_some, val }` struct form |
| `StorageType::Plaintext \| Vector` | `StorageType` | Preserved — `{ Plaintext } \| { Vector }` |
| `{ Array: { element, length } }` | `{ Array: [PlaintextType, number] }` | Object → tuple normalization |
| `Mode::Constant` | — | Not in `Mode` union |
| `Primitive::Signature` | — | Not in `PrimitiveType` |

Relevant source files:

- Type definitions: `packages/leo-compiler/src/abi-types.ts`
- Parser: `packages/leo-compiler/src/abi-parser.ts`
- TypeScript codegen: `packages/leo-compiler/src/codegen/typescript-generator.ts`
- Type mapping: `packages/leo-compiler/src/codegen/type-mapper.ts`
- Upgrade compatibility: `packages/plugin-deploy/src/abi-compat.ts`

## Design Direction

The JSON ABI is the stable contract between the Leo compiler and LionDen's toolchain. See [`compiler.md`](compiler.md) for how the ABI fits into the compile pipeline and codegen flow. See [`vision-and-roadmap.md`](vision-and-roadmap.md) for design goals around ABI-driven code generation.
