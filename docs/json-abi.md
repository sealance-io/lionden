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
| `mode` | `Mode` | Visibility mode |

### Output

| Field | Type | Description |
|---|---|---|
| `ty` | `FunctionOutput` | Output type |
| `mode` | `Mode` | Visibility mode |

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

LionDen's TypeScript types (`packages/leo-compiler/src/abi-types.ts`) normalize the compiler output for ergonomic consumption. The differences are intentional — the TS types are a simplified projection of the full schema.

| Compiler JSON (this spec) | LionDen TS types | Notes |
|---|---|---|
| `"functions"` array key | `transitions` / `TransitionABI` | Aleo-level naming |
| `"is_final"` | `is_async` | Semantic equivalence — `is_final` means "has finalize block" |
| `"path": ["Token"]` on structs/records | `name: string` | Flattened — last path segment used as name |
| `{ Struct: { path, program? } }` | `{ Struct: "name" }` | Flattened StructRef |
| `{ Record: { path, program } }` | `{ Record: "name" }` | Flattened RecordRef |
| `"Final"` output | `{ Future: string }` | Remapped variant name |
| `"DynamicRecord"` | — | Not represented |
| `Optional(Plaintext)` | — | Not represented |
| `StorageType::Vector(...)` | `PlaintextType` | Flattened — no Vector wrapper |
| `Mode::Constant` | — | Not in `Mode` union |
| `Primitive::Identifier` | — | Not in `PrimitiveType` |
| `Primitive::Signature` | — | Not in `PrimitiveType` |

Relevant source files:

- Type definitions: `packages/leo-compiler/src/abi-types.ts`
- Parser: `packages/leo-compiler/src/abi-parser.ts`
- TypeScript codegen: `packages/leo-compiler/src/codegen/typescript-generator.ts`
- Type mapping: `packages/leo-compiler/src/codegen/type-mapper.ts`
- Upgrade compatibility: `packages/plugin-deploy/src/abi-compat.ts`

## Design Direction

The JSON ABI is the stable contract between the Leo compiler and LionDen's toolchain. See [`compiler.md`](compiler.md) for how the ABI fits into the compile pipeline and codegen flow. See [`vision-and-roadmap.md`](vision-and-roadmap.md) for design goals around ABI-driven code generation.
