# JSON ABI

When to read this: use this file for the Leo compiler's JSON ABI schema, type serialization rules, CLI generation, and the differences between compiler output and LionDen's normalized TypeScript types. For generated bindings and helpers built from the ABI, use [`typechain.md`](typechain.md).

## Overview

The Leo compiler produces a JSON ABI (Application Binary Interface) file that describes the public interface of a compiled Leo/Aleo program. It enumerates every struct, record, mapping, storage variable, and function that the program exposes, along with their full type signatures.

LionDen consumes the ABI for two purposes:

1. **TypeScript code generation** — `packages/leo-compiler/src/codegen/` produces typed bindings from ABI data.
2. **Artifact management** — the ABI is copied to `artifacts/<programId>/abi.json`, stored in the LRE artifact store, and emitted per-program by `export`. LionDen does not diff ABIs for upgrade compatibility; upgrade correctness is owned by Leo's built-in tooling.

The authoritative type definitions live in the Leo compiler's Rust source at `crates/abi-types/src/lib.rs`. All types derive `serde::Serialize` and `serde::Deserialize`, so the JSON schema is a direct serde serialization of those Rust types.

## Wire Versions

The emitted ABI shape depends on the Leo line. LionDen's parser (`packages/leo-compiler/src/abi-parser.ts`) accepts every shape below and normalizes them to one internal representation (see [LionDen Normalization](#lionden-normalization)).

| Wire shape | Emitted by | Distinguishing features |
|---|---|---|
| Positional (current) | Leo 4.2+, including the default Leo line | Function and view I/O elements are bare enum variants (`{ Plaintext: { ty, mode } }`, `{ Record: { path, program } }`, `"Final"`, `"DynamicRecord"`). No input names, `is_final`, `const_parameters`, `implements`, or `"None"` mode. Self-program refs are explicit. Leo 4.3+ also writes `"mode": "Private"` on record-definition fields. Details: [Leo 4.2 Wire Shape](#leo-42-wire-shape). |
| Wrapper | Leo 4.1 / bytecode `leo abi` | I/O elements wrapped as `{ name?, ty, mode }`; `is_final`; `"None"` for unmoded values. |
| v3.5 | Leo 3.5 | `transitions` / `is_async` keys and a bare `"Future"` output. |

How to read the sections below: the type encodings (primitives, plaintext, structs, mappings, storage variables) are shared by all shapes, except for self-program references: Leo 4.1 writes `null` for a local struct, while Leo 4.2+ writes the program's own id (see [StructRef](#structref)). The examples that include function I/O or `mode` values (the Top-Level Schema minimal example, Records, and Functions) use the wrapper shape and are labeled as such. [Mode](#mode) separates wire values from LionDen's internal union, and [LionDen Normalization](#lionden-normalization) maps wire fields to the parsed `ProgramABI`.

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
| `views` | `View[]` | Optional, may be absent (Leo 4.1+). Read-only view functions with the same `name` / `inputs` / `outputs` shape as `functions`; unmoded view plaintext maps to `Public` (see [Mode](#mode)). Drives generated `contract.views` wrappers (see [`typechain.md` § View functions](typechain.md#view-functions)). |
| `implements` | array | Leo 4.1 only: interfaces the program implements. Removed in Leo 4.2 (see [Leo 4.2 Wire Shape](#leo-42-wire-shape)). |

The five core array fields (`structs`, `records`, `mappings`, `storage_variables`, `functions`) are present even when empty; `views` and `implements` are optional.

This table describes the compiler's wire fields. LionDen's parsed `ProgramABI` (`packages/leo-compiler/src/abi-types.ts`) differs: it renames `functions` to `transitions` and sets `views` / `implements` only when they are non-empty. See [LionDen Normalization](#lionden-normalization).

Minimal example (Leo 4.1 wrapper shape; the Leo 4.2+ form of this `main` function is under [Leo 4.2 Wire Shape](#leo-42-wire-shape)):

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
{ "Primitive": "Signature" }
{ "Primitive": { "UInt": "U64" } }
{ "Primitive": { "Int": "I32" } }
```

Leo identifier values are represented as single-quoted literals on the wire, for example `'voting_power'`. Generated TypeScript bindings keep identifiers branded: outputs use `LeoIdentifier`, inputs use `IdentifierInput` (`LeoIdentifier`), and callers pass `Leo.identifier("voting_power")` rather than a bare string. The runtime serializer still normalizes bare or already quoted identifier text to the quoted wire form, and outputs parse back to a branded bare name.

LionDen's ABI parser preserves `Signature` exactly as emitted by the Leo compiler JSON ABI. Generated TypeScript bindings intentionally reject `Primitive::Signature` for now because the runtime serializer/parser layer does not yet provide signature-specific support. A compile with typechain enabled fails with `CodegenError` instead of emitting incorrect fallback types. Do not model signatures as `number`, `string`, or a public `SignatureInput` type until dedicated serializer/parser support exists.

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
| `program` | `string \| null` | The program containing this struct, if external. `null` for local structs in the Leo 4.1 wire shape and in LionDen's parsed ABI; Leo 4.2+ writes the program's own id, which the parser rewrites to `null` (see [Leo 4.2 Wire Shape](#leo-42-wire-shape)). |

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
| `mode` | `Mode` | Visibility mode for this field (absent in Leo 4.2; see [Mode](#mode)) |

Example (Leo 4.1 wrapper shape, with `"None"` modes):

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

The per-record helpers codegen emits (`serialize<Name>`, `deserialize<Name>`, `decrypt<Name>`) are documented in [`typechain.md` § Generated record helpers](typechain.md#generated-record-helpers).

### Interface Conversion Helpers (`codegen.dynamicRecords`)

`codegen.dynamicRecords` configuration (naming, targeted compile, schema rules, and validation layers) is documented in [`typechain.md` § Dynamic-record helper configuration](typechain.md#dynamic-record-helper-configuration). The emitted helpers, their `.output` matchers, and `.forProgram(...)` are documented in [`typechain.md` § Interface conversion helpers](typechain.md#interface-conversion-helpers).

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
see [`typechain.md` § Mapping accessors](typechain.md#mapping-accessors).

## Storage Variables

Persistent on-chain state. Leo supports both singleton values (`storage name: Type`) and dynamic lists (`storage name: [Type]`).

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Variable name |
| `ty` | `StorageType` | Storage type |

Storage variables use `StorageType`, not plain `Plaintext`, so vector storage is distinguishable from fixed-length plaintext arrays. `StorageType` is an enum. The first three columns describe the wire shape; the last lists the generated TypeScript accessors:

| Variant | JSON shape | Description | Generated access |
|---|---|---|---|
| `Plaintext` | `{ "Plaintext": ... }` | A single plaintext value | zero-argument `get()`, `tryGet()`, `getOrUse(def)` |
| `Vector` | `{ "Vector": ... }` | A dynamic-length list of a `StorageType` | `len()`, `get(index)`, `tryGet(index)`, `getOrUse(index, def)`, `getAll()`, `toArray()` |

A `Plaintext.Array` storage variable remains a regular storage value and keeps the zero-argument accessor API. Only the top-level `StorageType.Vector` variant gets indexed accessors.

Vectors lower to two on-chain mappings at the Aleo level: elements are `<name>__` at key `"<index>u32"`, and the length is `<name>__len__` at key `"false"`. Generated vector reads use this lowered representation and surface a missing length as `0`; see [`typechain.md` § Storage accessors](typechain.md#storage-accessors).

```json
{ "name": "admin", "ty": { "Plaintext": { "Primitive": "Address" } } }
```

Storage vector (illustrative):

```json
{ "name": "whitelist", "ty": { "Vector": { "Plaintext": { "Primitive": "Address" } } } }
```

## Functions

Public entry points declared inside `program {}`. Each function compiles to an Aleo `transition`. Functions with `is_final: true` have a finalize block that executes on-chain after the transition.

The tables and examples in this section use the Leo 4.1 wrapper shape. In the Leo 4.2+ positional shape, `is_final` and input names are gone and each I/O element is a bare `FunctionInput` / `FunctionOutput` variant; see [Leo 4.2 Wire Shape](#leo-42-wire-shape).

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
| `mode` | `Mode` | Visibility mode (see [Mode](#mode)) |

### Output

| Field | Type | Description |
|---|---|---|
| `ty` | `FunctionOutput` | Output type |
| `mode` | `Mode` | Visibility mode (see [Mode](#mode)) |

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

The mode records the visibility modifier Leo declared on each function or view input and
output, and on each record field. Two layers are involved: the **wire** values the compiler
emits, which depend on the Leo version, and LionDen's **internal** `Mode` union, which the
parser produces and codegen consumes.

**Wire values.** 4.1 emits `"None"` for unmoded values; 4.2 dropped `None` and emits
`"Private"`/`"Public"`/`"Constant"` explicitly.

| Value | Wire | Description |
|---|---|---|
| `"None"` | Leo 4.1 / v3.5 only | No modifier written; canonicalized by the parser to `"Private"` (transitions, record fields) or `"Public"` (views). Removed from the Leo 4.2 ABI. |
| `"Constant"` | Leo 4.2 | Immutable compile-time constant |
| `"Private"` | all | Kept private off-chain (encrypted in the transaction) |
| `"Public"` | all | Publicly visible on-chain |

In the Leo 4.2+ positional shape only `Plaintext` I/O elements carry a mode;
`Record`/`Final`/`DynamicRecord` elements carry none. Record-definition fields carry no mode
in Leo 4.2 and an explicit `"Private"` from Leo 4.3.

**Internal `Mode` union:**

```
Mode = "Public" | "Private" | "Constant"
```

- `"Public"` — explicit `public` modifier; the value travels on chain as a plain Leo literal.
- `"Private"` — explicit `private` modifier, **or** the canonicalized form of an unmoded
  (4.1 `"None"`, or absent) transition input/output or record field.
- `"Constant"` — immutable compile-time constant (Leo 4.2).

The parser canonicalizes an unmoded value to `Private` for transitions/record fields and
`Public` for views, so `"None"` never reaches codegen. Mode is only meaningful for the
`Plaintext` variant; `Record`/`Final`/`DynamicRecord` carry an inert `Private` that is never read.

**Generated access.** LionDen codegen consumes `mode` when projecting on-chain transition outputs into the typed `outputs` field of `AcceptedTransition<TOutputs>`. Plaintext outputs with `mode: "Public"` are decoded eagerly to their TS type. Plaintext outputs with `mode: "Private"` (or `"Constant"`) come back as Aleo value ciphertexts (`ciphertext1...`) on chain and are wrapped as `EncryptedValue<T>` handles in the typed shape — the caller invokes `outputs.decrypt(key)` to decode them. Record outputs are similarly wrapped as `EncryptedRecord<T>`. See [`typechain.md` § Typed broadcast results](typechain.md#typed-broadcast-results) for the typed-broadcast contract.

## Leo 4.2 Wire Shape

Leo 4.2 (ProvableHQ/leo#29481, "interface compatibility check and slimmer ABI") ships an
**intentional breaking change** to the emitted JSON ABI. The function, record, and mode
examples above use the Leo 4.1 / bytecode-`leo abi` wrapper shape, which the parser still
accepts; this section records what 4.2 emits (later lines keep this shape, see
[Wire Versions](#wire-versions)) and how LionDen normalizes it. The parser is **shape-detecting** —
the three forms (v3.5, 4.1/internal, 4.2) all normalize to the same internal representation,
and re-parsing an already-normalized ABI is a fixed point.

**What changed in 4.2:**

- **`Program.implements` removed.** Interface conformance moved to `leo abi --satisfies`.
- **`Function.is_final` removed.** "Async / has-finalize" is inferred from a `Final` output.
- **`Function.const_parameters` removed.**
- **Function input names removed.** Inputs are positional; LionDen synthesizes `arg0`,
  `arg1`, … (and preserves existing names when parsing a 4.1 snapshot — see below).
- **I/O wrappers removed.** A 4.2 input/output element is the bare enum variant itself:
  - Plaintext: `{ "Plaintext": { "ty": <plaintext>, "mode": "Private" | "Public" | "Constant" } }`
  - Record: `{ "Record": { "path": [...], "program": "..." } }` (**no mode**)
  - `"Final"` and `"DynamicRecord"` as bare strings (**no mode**)
- **`Mode::None` removed.** Unmoded transition plaintext is emitted as `Private` and unmoded
  view plaintext as `Public`. Record-definition fields carry no `mode` (Leo 4.3+ emits an
  explicit `"Private"`); the parser reads both as `Private`. Record / `Final` /
  `DynamicRecord` I/O elements carry no mode.
- **Self type references are explicit.** A struct/record ref to the program's own type now
  carries `program: "<self>.aleo"` where 4.1 emitted `program: null`.

A 4.2 `main` function (compare to the 4.1 example under [Top-Level Schema](#top-level-schema)):

```json
{
  "name": "main",
  "inputs": [
    { "Plaintext": { "ty": { "Primitive": { "UInt": "U32" } }, "mode": "Private" } },
    { "Plaintext": { "ty": { "Primitive": { "UInt": "U32" } }, "mode": "Private" } }
  ],
  "outputs": [
    { "Plaintext": { "ty": { "Primitive": { "UInt": "U32" } }, "mode": "Private" } }
  ]
}
```

**Dual-shape parser contract.** `parseAbi` detects per-element which shape applies: a
top-level `ty` key marks the 4.1/internal wrapper (so a 4.1 input literally named `Plaintext`
is not mistaken for a 4.2 positional `Plaintext` element); a bare string is a v3.5/4.2 unit
variant; otherwise a root `Plaintext`/`Record`/`Future` key is the 4.2 positional form. The
parser canonicalizes so a stored 4.1 snapshot and a fresh 4.2 ABI for the same program
compare equal:

- **Names** are synthesized as `arg{i}` only when absent; existing 4.1 names are preserved.
- **Modes** — `None`/absent plaintext → `Private` (transitions, record fields) or `Public`
  (views); `Public`/`Private`/`Constant` pass through; non-plaintext I/O gets an inert
  `Private` that is never read.
- **`is_async`** — taken from `is_async`, else `is_final`, else inferred from a `Future`/`Final` output.
- **Self-refs** — a ref whose `program` equals the program's own id is rewritten to
  `program: null` across **every** plaintext surface: struct and record definitions,
  mapping keys/values, storage variables, and function/view I/O.

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

**During build** — `leo build` compiles Leo source and writes `abi.json` under `build/` alongside the compiled Aleo program: `build/<program>/abi.json` in the Leo 4.2+ single-program layout, `build/<unit>/abi.json` in Leo 4.1 per-unit layouts, or `build/abi.json` in the legacy layout. This is the primary path used by LionDen's compile pipeline.

**Standalone extraction** — `leo abi <program.aleo>` reads a compiled `.aleo` file and outputs the ABI:

```
leo abi program.aleo                              # print to stdout
leo abi program.aleo --output program_abi.json    # write to file
leo abi program.aleo --network mainnet            # specify network context
```

LionDen locates the ABI through `resolveBuildArtifacts()` in `readProgramAbi()` (`packages/leo-compiler/src/compiler.ts`), parses it with `parseAbi()` (`packages/leo-compiler/src/abi-parser.ts`), and stores it in the LRE artifact store.

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
| `Mode::None` (4.1) / absent (4.2) | `"Private"` or `"Public"` | Canonicalized by context: `Private` for transitions/record fields, `Public` for views |
| `Mode::Constant` | `"Constant"` | In the `Mode` union (`Public \| Private \| Constant`) since Leo 4.2 |
| 4.2 positional input (no name) | `name: "arg{i}"` | Synthesized only when absent; existing 4.1 names preserved |
| self struct/record ref `program: "<self>.aleo"` (4.2) | `program: null` | Self-refs collapsed to the local convention across all surfaces |
| `Primitive::Signature` | `"Signature"` | Preserved by the parser; rejected by codegen with `CodegenError` (no serializer/parser support yet) |

Relevant source files:

- Type definitions: `packages/leo-compiler/src/abi-types.ts`
- Parser: `packages/leo-compiler/src/abi-parser.ts`
- TypeScript codegen: `packages/leo-compiler/src/codegen/typescript-generator.ts`
- Type mapping: `packages/leo-compiler/src/codegen/type-mapper.ts`

## Design Direction

The JSON ABI is the stable contract between the Leo compiler and LionDen's toolchain. See [`compiler.md`](compiler.md) for how the ABI fits into the compile pipeline and codegen flow. See [`vision-and-roadmap.md`](vision-and-roadmap.md) for design goals around ABI-driven code generation.
