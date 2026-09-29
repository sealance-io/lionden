# Typechain

When to read this: use this file for the TypeScript bindings LionDen generates from compiled program ABIs (the typechain): `codegen.*` configuration, generated files, wrapper options and program identity, transition input types, view/mapping/storage accessors, record and interface-conversion helpers, typed broadcast results, and id-only record outputs. For the compile pipeline and how the ABI reaches codegen, use [`compiler.md`](compiler.md#abi-and-generated-bindings). For the ABI wire schema, serde rules, and normalization, use [`json-abi.md`](json-abi.md). For low-level `connection.execute()`, transaction confirmation, and the runtime-imports policy, use [`network.md`](network.md). For test contexts, devnode lifecycle, and the `test` task, use [`testing.md`](testing.md). For the V15 record-existence rules behind dynamic-record recovery, use [`research/dynamic-records-v15.md`](research/dynamic-records-v15.md).

## Overview

Generated bindings are the preferred user-facing API when the ABI is known. They encode ABI shape, Leo value serialization, visibility, encrypted output handles, and record helpers in TypeScript. Raw string execution remains available as an escape hatch for dynamic ABI situations, post-upgrade calls, or cases where the generated wrapper cannot yet model the call.

## Codegen configuration

All `codegen.*` keys are optional:

| Key | Default | Effect |
| --- | --- | --- |
| `codegen.enabled` | `true` | Generates TypeScript bindings during `compile`. `false` skips generation; `compile --no-typechain` skips it for a single run regardless of this setting. |
| `codegen.outDir` | top-level `typechainDir`, whose default is `"typechain"` | Output directory, relative to the project root. When set, it overrides `typechainDir`. The resolved absolute path is `config.paths.typechain`. |
| `codegen.dynamicRecords` | none | Map from emitted helper name to `{ sourceRecord, sourceProgram?, schema }`. `sourceProgram` disambiguates record ownership and scopes helpers during targeted compilation. See [§ Dynamic-record helper configuration](#dynamic-record-helper-configuration). |

### Dynamic-record helper configuration

Programs that consume Leo v4 `dyn record` inputs through a shared interface (e.g. `compliant_amm` accepting any `Token`-shaped record) need a single-line conversion at every call site. When the concrete source record ABI is known, codegen can emit those conversion helpers from a project-wide `codegen.dynamicRecords` map keyed by helper name:

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

**Naming**: `sourceRecord` must match the generated TS record type name (`pathToTsName(record.path)`). For module-scoped records, that's the joined PascalCase form, e.g. `Foo_Bar_Token` for `foo::bar::Token`. Set `sourceProgram` when more than one compiled program declares the same generated record name; `examples/aleo-ports/dynamic_records` uses this for `gold_token.aleo::Token` and `silver_token.aleo::Token`.

On targeted compile (`compile --program`), helpers with `sourceProgram` outside the compiled subset are ignored for that run. Full compile remains strict. Helpers without `sourceProgram` still validate against the compiled subset and may require explicit `sourceProgram` when compiling one program at a time.

**Schema rules**:

- Schema keys must exactly match the **generated record shape**: implicit `owner: address`, every ABI field that isn't a re-declaration of `owner`, and implicit `_nonce: group`. The schema may additionally declare optional `_version: "u8.public"` metadata (it must be a public `u8`); the value may omit it.
- The emitted literal always follows the canonical record layout (`owner`, ABI fields in ABI order, `_nonce`, then `_version`); the key order in the config is irrelevant.
- Schema entry primitives must match each record field's declared type (visibility may differ — that's the point of the helper).
- Supported primitives: `address`, `boolean`, `field`, `group`, `scalar`, `u8`-`u128`, `i8`-`i128`. `Identifier`, `Signature`, struct, array, and optional fields are rejected with `CodegenError` at compile time.

**Validation layers**:

- **Config shape** (plugin-leo `validateUserConfig` hook): non-object map, invalid helper names, non-object helpers, malformed schema entries → aggregated into `ConfigResolutionError`.
- **ABI routing** (plugin-leo compile task): `sourceRecord` does not match a compiled program, ambiguous record name without `sourceProgram`, or `sourceProgram` doesn't declare the record → `CodegenError`.
- **Schema vs generated record** (typescript-generator emit): missing/extra schema keys or primitive-type mismatch → `CodegenError`.

The emitted helper, its `.output` matcher, and how it preserves decrypted record metadata are described in [§ Interface conversion helpers](#interface-conversion-helpers).

## Generated files

After compiling, the `compile` task in `@lionden/plugin-leo` generates TypeScript output unless `codegen.enabled` is `false` or `--no-typechain` is passed:

- `BaseContract.ts`
- one generated wrapper per compiled program

Generated files are written under `config.paths.typechain`.

## Wrapper options and program identity

Each generated wrapper factory accepts a `BaseContractOptions` argument:

```ts
const governance = createGovernance({
  imports: ["voting_power.aleo", "quadratic_power.aleo"],
});
```

Every wrapper exposes the owning program identity through `contract.programId`
and the generated source identity through `contract.sourceProgramId`. By
default they are equal. Passing `createToken({ programId: "renamed_token.aleo" })`
keeps the same generated class and transition methods but targets the renamed
on-chain program id for execution, mapping/storage reads, and address
derivation. The address is computed from the runtime program id, so it is
available before deployment and is not a deployment-state record.

`imports` carries runtime imports that the wrapper attaches to every transition call — useful for dispatch hubs that need the same set of dynamic targets on each call. The same option also appears on `BaseCallOptions` as a per-call additive layer, and `withSigner()` clones preserve the instance-level list. Config-level runtime imports are keyed by the effective runtime `programId`, not `sourceProgramId`; see [`network.md` § Runtime Imports For Dynamic Dispatch](network.md#runtime-imports-for-dynamic-dispatch) for the full layered model.

## Scalar inputs (field / scalar / group)

Transition arguments and mapping keys typed `field`, `scalar`, or `group` accept either a branded value from `Leo.field(...)` / `Leo.scalar(...)` / `Leo.group(...)` or a bare non-negative integer — `bigint` or `number` — which is auto-suffixed during serialization. So `pool_id: 1n` and `pool_id: Leo.field(1n)` are equivalent, and the same widening applies to the `Leo.*` constructors themselves, which now take `bigint | number | string`.

Validation rules:

- Values must be non-negative integers. A `number` above `2^53 - 1` is rejected (it cannot be represented exactly) — pass a `bigint` or string for large field values.
- String inputs accept a bare-numeric form (`"12"`, auto-suffixed) or an already-suffixed literal (`"12field"`); visibility-suffixed strings (`"12field.public"`) are rejected on the input path. `group` is limited to integer literals.

Type-safety tradeoff: branded values (`LeoField`, etc.) remain cross-type checked — a `LeoField` is not assignable where a `GroupInput` or `AddressInput` is expected. Bare numerics, however, are interchangeable across the three scalar slots (consistent with how integer inputs already work). Outputs and stored values stay branded, so reads remain strongly typed. Pass `Leo.field(...)` explicitly when you want the stricter cross-type guarantee at a call site.

## Composite inputs (structs / records)

Struct and record types are emitted as two interfaces: a branded `Name` (used for
outputs — return values, mapping values, decrypted records, storage reads) and a
widened `NameInput` (used for inputs — transition arguments, mapping keys, and the
serializer signature). `NameInput` types every field through the input binding, so
scalar fields accept `bigint | number`, address fields accept `AddressInput`, and
nested arrays/structs/records widen recursively. A `MerkleProof` with
`siblings: field[]` can therefore be passed as a plain literal:

```ts
await amm.add_liquidity.locally(
  1n,
  [{ siblings: [1n, 2n], leaf_index: 0 }], // no per-element Leo.field(...)
  // …
);
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

When generated wrappers can resolve cross-program struct or record references at
codegen time, LionDen imports them under synthesized aliases such as
`${ProgramClass}_${TypeName}`. If such an alias would collide with a local
declaration in the same generated module, the emitter appends underscores
deterministically until the name is unique, preserving valid TypeScript without
changing non-collision output.

Address caveat: `AddressInput` is `LeoAddress | { readonly address: string }`. A
record `owner` or an address-typed field accepts a wrapper object (`{ address:
"aleo1…" }`) or `Leo.address("aleo1…")`, but not a bare `aleo1…` string — wrap it.

## View functions

When an ABI contains views, its generated contract has a dedicated `readonly views` namespace:

```ts
const total = await contract.views.getTotal(owner);
const [balance, nonce] = await contract.views.getState(owner);
await contract.views.refresh();
```

View calls are read-only network queries. They do not require a signer, create or submit a transaction, accept transaction options, or expose transition helpers such as `locally`, `submitted`, `accepted`, or `settled`. Inputs use the same widened TypeScript types and Leo serialization as transition inputs; outputs use the same generated deserializers as other reads.

The return shape follows ABI output arity: zero outputs returns `Promise<void>`, one output returns `Promise<T>`, and multiple outputs return `Promise<[T1, T2, ...]>`.

LionDen sends view calls through the configured network connection using `POST /{network}/program/{programId}/view/{viewName}`, whose JSON request and response are arrays of Leo-encoded strings. This request is attempted for both devnode and HTTP connections. If the configured provider does not implement the endpoint, LionDen surfaces the provider's response as an actionable HTTP error with the program ID and view name.

## Mapping accessors

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
generated `BaseContract.ts`; consumers import it from `typechain/BaseContract.ts`.

### Option-valued mappings

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

## Storage accessors

Each ABI storage variable is emitted under a separate per-contract `storage` namespace,
keyed by the variable's camelCased name.

Regular `StorageType.Plaintext` variables are not modeled as mappings, so their accessors
do not accept a key. This includes fixed-length plaintext arrays such as
`Plaintext.Array`:

- `get(): Promise<Value>` — returns the deserialized value and throws
  `StorageValueNotFoundError` when the value is absent.
- `getOrUse(def): Promise<Value>` — returns `def` when the value is absent.
- `tryGet(): Promise<Value | null>` — returns `null` when the value is absent.

`StorageType.Vector` variables expose vector-specific accessors instead:

- `len(): Promise<number>` — reads the lowered `<name>__len__` mapping with key `"false"`;
  missing length storage returns `0` to match Leo-level vector semantics.
- `get(index): Promise<Value>` — checks the current length, then reads `<name>__` with
  key `"<index>u32"` and throws `StorageValueNotFoundError` when the index is outside
  the current length or the indexed entry is absent.
- `getOrUse(index, def): Promise<Value>` — returns `def` when the index is outside the
  current length or the indexed entry is absent.
- `tryGet(index): Promise<Value | null>` — returns `null` when the index is outside the
  current length or the indexed entry is absent.
- `getAll(): Promise<Value[]>` — reads the current length once, then reads indices
  `[0, length)` in order, returning the deserialized elements. Throws
  `StorageValueNotFoundError` on a torn read (an in-range index whose entry is absent).
  Stale lowered entries beyond the current length (left by `pop`/`clear`) are never read.
- `toArray(): Promise<Value[]>` — alias for `getAll()`.

## Generated record helpers

For every record in the ABI, codegen emits three helpers (plus the interface):

- `serialize<Name>(value, ctx?): string` — JS object → Leo literal. Round-trips losslessly via the `BaseContract.RECORD_RAW` symbol cache so visibility-suffixed records survive re-input.
- `deserialize<Name>(value): <Name>` — Leo literal → typed JS object. Stashes the raw literal on `RECORD_RAW` for future re-serialization.
- `async decrypt<Name>(ciphertext, key): Promise<<Name>>` — `record1...` ciphertext + decryption key → typed JS object. Internally delegates to `BaseContract.decryptRecord` which awaits `@lionden/network`'s SDK-load and runs `deserialize<Name>` over the plaintext; RECORD_RAW is preserved through this path too.

Imported records (records declared in another program) reuse the originating program's generated helpers — no duplicate emission. See [§ Typed broadcast results](#typed-broadcast-results) for the decrypt key API and `SettledTransition.rawOutputs` transition-identity contract.

## Interface conversion helpers

Each [`codegen.dynamicRecords`](#dynamic-record-helper-configuration) entry emits a helper, such as `asPoolToken` from the configuration example, that converts a generated concrete record into a Leo v4 `dyn record` input. Use it when a generated concrete record, such as `gold_token.aleo::Token`, must be passed to a shared `dyn record` interface; `examples/aleo-ports/dynamic_records` shows it end to end.

The emitted helper lives alongside `decrypt<Name>` in the source program's generated module, using a callable+namespace pattern (`Object.assign`) so the helper is both a function and a namespace carrying the output-side `.output` matcher and a `.forProgram(...)` rebinding method:

```ts
// typechain/StableToken.ts (generated)
function _asPoolTokenImpl(value: TokenInput & { readonly _version?: number }): LeoDynamicRecord {
  BaseContract.assertObject(value);
  const _raw = (value as unknown as { readonly [k: symbol]: unknown })[BaseContract.RECORD_RAW];
  if (typeof _raw === "string") return Leo.unsafe.dynamicRecord(_raw);
  return Leo.dynamicRecord(value, {
    owner: "address.private" as const,
    amount: "u128.private" as const,
    _nonce: "group.public" as const,
    _version: "u8.public" as const,
  } as const);
}
export const asPoolToken = Object.assign(_asPoolTokenImpl, {
  output: createRecordOutputMatcher<Token>({
    program: "stable_token.aleo",
    recordName: "Token",
    deserialize: deserializeToken,
  }),
  forProgram(programId: string) {
    return bindDynamicRecordHelperProgram(_asPoolTokenImpl, asPoolToken.output, programId);
  },
});
```

The value type gains `& { readonly _version?: number }` only when the schema declares `_version`. The codegen golden [`interface-helpers.ts`](../packages/leo-compiler/src/codegen/__goldens__/interface-helpers.ts) is the authoritative current output for this configuration.

For decrypted records, the helper reuses the original plaintext cached under `BaseContract.RECORD_RAW`. As with the concrete serializer, that cached plaintext takes precedence over the object fields and the schema encoding, so runtime metadata such as field visibility and `_version` survives, even when `_version` is absent from the ABI. Pass the original decrypted object when spending a held record: object spread, `structuredClone`, and JSON round-trips drop the non-enumerable `RECORD_RAW` cache. To persist a held record, store the plaintext string from `serialize<Name>` (or the ciphertext) and rehydrate it through `deserialize<Name>` or `decrypt<Name>`, which re-attach the cache. Losing `_version` changes the record commitment, so a proving spend of the held record fails even though the no-proof devnode path accepts it; see [`research/dynamic-records-v15.md` § Held Records And Inclusion Proofs](research/dynamic-records-v15.md#held-records-and-inclusion-proofs-verify-vs-prove).

Manually constructed inputs carry no cache, so the helper wraps `Leo.dynamicRecord(...)` with the configured schema and its validation. Declaring `_version: "u8.public"` in the schema lets them carry the record version (`_version: 1` on the value); omitting `_version` on the value yields a versionless literal, which the VM reads as version 0.

Callers import `asPoolToken` directly for input conversion:

```ts
await amm.add_liquidity.locally(asPoolToken(tok), /* ... */);
```

The same helper is the preferred output-side matcher when the dispatched call returns a `dyn record` handle:

```ts
const accepted = await amm.route_transfer.accepted(asPoolToken(tok), to);

const recovered = await accepted.outputs
  .match(asPoolToken.output.from("transfer", 0))
  .decrypt(to);
```

**`.output`** is a `RecordOutputMatcher<T>` carrying the program id, source record name, the matching deserializer, and `.from(...)` / `.at(...)` builders that bind a transition source. It works with every record-output handle: `EncryptedRecord<T>`, `IdOnlyExternalRecordHandle<T>`, and `IdOnlyDynamicRecordHandle`. Source binding, the `EncryptedRecord<T>` identity guard, and resolution errors are documented once in [§ Id-only record outputs](#id-only-record-outputs-dyn-record-and-external-record).

**`.forProgram(programId)`** returns a new helper, leaving the original unchanged, whose `.output` matcher is bound to a runtime program id, so `.from(...)` and the identity guards use that id. Use it when the source program is deployed under another id, for example with `deploy --rename` (which requires `leoVersion` 4.3.0 or newer; see [`deployment.md` § Deploy Rename](deployment.md#deploy-rename)); input conversion is unchanged:

```ts
const asTenantPoolToken = asPoolToken.forProgram("tenant_stable_token.aleo");

const recovered = await accepted.outputs
  .match(asTenantPoolToken.output.from("transfer", 0))
  .decrypt(to);
```

See [`examples/renamed_dynamic_records`](../examples/renamed_dynamic_records/test/renamed_dynamic_records.test.ts) for an end-to-end renamed deployment.

**Cross-program external records** do not need a dynamic-record helper to be decrypted. They emit a sibling `<ExternalRecord>.output` value binding alongside the imported type. For example, an `external_token_demo.aleo` typechain that imports `gold_token.aleo::Token` produces both the type alias `GoldToken_Token` and a value `GoldToken_Token.output: RecordOutputMatcher<GoldToken_Token>`, with no `codegen.dynamicRecords` entry. External types whose ABI is unavailable at codegen time get no typed matcher; see the [matcher sources](#id-only-record-outputs-dyn-record-and-external-record) for the fallback.

## Typed broadcast results

`.accepted(...)` returns `AcceptedTransition<TOutputs>`, `.settled(...)` returns the union `AcceptedTransition<TOutputs> | RejectedTransition`, and `.rejected(...)` returns `RejectedTransition`. The `outputs` field on `AcceptedTransition<TOutputs>` mirrors `.locally()`'s return shape with two substitutions driven by what the chain returns encrypted:

- **Record outputs** → `EncryptedRecord<RecordName>` handles with `decrypt(key): Promise<RecordName>`.
- **Private plaintext outputs** (Leo's default visibility) → `EncryptedValue<T>` handles with `decrypt(key): Promise<T>`.
- **Public plaintext outputs** → decoded eagerly via the same deserializers used by `.locally()`.

`AcceptedTransition<TOutputs>` also carries `transitionPublicKey: string` — the on-chain `tpk` needed by the SDK to decrypt private value ciphertexts. It's threaded through `EncryptedValue<T>.decrypt(...)` automatically; callers don't pass it directly. `RejectedTransition` has no `outputs` and no `transitionPublicKey` (fee-only inclusion carries neither).

```ts
// Single record output → outputs is an EncryptedRecord<Token>
const mintTx = await token.mint_private.accepted(receiver, 100n);
const mintedRecord = await mintTx.outputs.decrypt(ctx.accounts[0]);
await token.transfer_private.locally(mintedRecord, /* ... */);

// Multi-output (Token, bigint) → outputs is a positional tuple
const swap = await amm.swap.accepted(/* ... */);
const [encryptedToken, leftoverAmount] = swap.outputs;
const decoded = await encryptedToken.decrypt(ctx.accounts[0]);

// Private plaintext output: u64 without `public` modifier → EncryptedValue<bigint>
const compare = await governance.compare_strategies.accepted(10000n);
const [linear, quadratic] = compare.outputs;
expect(await linear.decrypt(ctx.accounts[0])).toBe(10000n);
expect(await quadratic.decrypt(ctx.accounts[0])).toBe(100n);
```

`rawOutputs: readonly RawTransitionOutput[]` is still available alongside `outputs` on every settled result. String entries carry the raw on-wire values from the specific transition the caller invoked (record ciphertexts, value ciphertexts, plain literals — whatever the chain returned). Id-only dynamic-record outputs are preserved in position as `{ kind: "idOnly", id, type }` entries, so ABI-indexed projectors do not shift later outputs.

### Why private plaintext outputs need `decrypt`

Aleo encrypts every non-`public` transition input and output on chain. The local SDK gives `.locally()` decoded plaintexts, but `.accepted()` / `.settled()` see the raw chain shape: `record1...` for record outputs, `ciphertext1...` for private plaintext outputs. `EncryptedValue<T>` wraps the value ciphertext + the per-output context (tpk, program, function, AVM global index) so a single `decrypt(key)` call drives `Ciphertext.decryptWithTransitionInfo(...)` under the hood. Public plaintext outputs are not encrypted on chain, so they're decoded eagerly with no `decrypt` hop.

### Future-typed outputs

`outputs` carries only client-decodable transition outputs. Future-typed outputs (post-finalization values) appear in `rawOutputs` at their original ABI index but are not represented in the typed `outputs` projection. To inspect a Future output, read `rawOutputs[i]` at its original ABI index — the projector preserves positions, so an output at ABI index 1 always wraps `rawOutputs[1]` even if a Future occupies index 0.

### `EncryptedRecord<T>` / `EncryptedValue<T>` decryption keys

Both handles' `.decrypt(key)` accept the same polymorphic key shape (aliased as `DecryptionKey` for clarity, identical to `RecordDecryptionKey`): a raw `APrivateKey1...` / `AViewKey1...` string (auto-detected by prefix), `{ viewKey }`, or `{ privateKey }`. Lionden `SignerInput` and devnode account objects (`{ privateKey, address }`) structurally match the `{ privateKey }` arm. Unrecognized strings throw `RecordDecryptionKeyError`. SDK / ciphertext failures throw `LocalRecordDecryptionError` (records) or `LocalValueDecryptionError` (values) — keeping the error name aligned with the decryption phase.

For workflows that need to defer decryption — pass the ciphertext between processes, decrypt under a different account, batch decrypts — read `mintTx.outputs.ciphertext` directly and call `decrypt<RecordName>(ciphertext, key)` (records) or `decryptValueCiphertext(ciphertext, viewKey, tpk, programId, transitionName, globalIndex)` (values) later. The free `decrypt<RecordName>` functions remain generated alongside the typed projection.

### `rawOutputs` transition identity

`rawOutputs` is filtered from the confirmed transaction's `transitions[]` by `(programId, transitionName)` match:

- **Accepted**: exactly one matching transition is required. 0 or >1 throws `TransactionShapeError` so test assertions don't pick the wrong outputs from a cross-program tx. Reentrant or recursive flows must opt out of the default await and inspect transitions directly — pass `{ awaitConfirmation: false }` to `ctx.raw.execute(...)` and call `ctx.connection.waitForConfirmation(txId)` to walk `transitions[]` yourself (or use `ctx.connection.getTransitionOutputs(...)` for a single targeted transition by `(programId, transitionName)`).
- **Rejected**: Aleo converts rejected executes to fee-only on inclusion, so `rawOutputs` is typically `[]`. The selector stays permissive — if a matching transition entry IS present, its outputs are surfaced; if multiple match, the first is picked. This preserves `.rejected()` semantics for finalizer failures.

`RejectedTransition` does not carry an `outputs` field — fee-only inclusion has no typed-output projection to project.

### Error policy for typed projection

`.settled()` and `.accepted()` wrap their typed projector with a narrow error policy:

- `TransactionShapeError` thrown by the projector (from `BaseContract.rawOutputAt`, which validates per-index access) is **rethrown unchanged**, preserving the `outputIndex` context.
- Any other error from the projector — including `TransitionInputError` from per-primitive parsers and native `Error` — is **wrapped as `TransactionShapeError` with `.cause` set** to the original. This keeps "bad on-chain data" failures classified as shape errors rather than misleading the caller that they provided bad input.

For `EncryptedValue<T>.decrypt(key)` specifically: only `RecordDecryptionKeyError` (caller-input shape) passes through unwrapped. SDK failures, malformed-ciphertext rejections from the SDK, and deserializer failures (even other `LionDenTypechainError` subclasses) wrap as `LocalValueDecryptionError` with `outputIndex` populated. This narrow pass-through makes "wrong account" / "malformed plaintext" failures surface under a single phase-aligned error name.

## Id-only record outputs (`dyn record` and external `Record`)

Two output shapes the Aleo REST layer exposes id-only on the surfacing transition — the typechain surfaces them as honest, distinct handle types rather than an `EncryptedRecord<T>` that would crash on access:

- **`dyn record` outputs** → `IdOnlyDynamicRecordHandle`. Carries id + `transitions` callgraph for inspection, plus `.match(matcher.from(...))` / `.match(matcher.at(...))` to bind a source. The chain never exposes a ciphertext for the `record_dynamic` id itself — not on the caller's transition, not on the producing transition — so the match does **not** dereference the dynamic id. It targets an explicit sibling output, typically the static record that snarkVM's V15 record-existence rule requires a compliant transfer to emit alongside the dynamic handle. For pre-V15 programs that cast and drop their static record, no such sibling exists and `.decrypt()` raises `not-a-ciphertext` — the honest answer for a program that has no recoverable record anywhere on the chain.
- **External `Record` outputs** → `IdOnlyExternalRecordHandle<T>` with the same `.match(matcher).decrypt(key)` flow. The ciphertext lives on the **callee** transition (the imported program's transition that actually emitted the record), so the caller picks the source explicitly via:
  - `.from(transitionName, outputIndex, { match: n? })` — named binding, the default for application code. The matcher's `program` is inherited as the source `programId`, so callers cannot accidentally point at a different program by name. `{ match: n }` disambiguates when the same `(program, transitionName)` appears more than once.
  - `.at(transitionIndex, outputIndex)` — positional binding into `transitions[i].rawOutputs[j]`. Use this when name-based disambiguation is awkward (you'd rather index directly) or when authoring an intentional cross-program mismatch test. Successful decryption still requires the selected transition's `programId` to equal the matcher's `program` — any mismatch surfaces as `program-mismatch` from `.decrypt(key)`.

`.match(matcher)` is a pure builder — it captures intent without running any validation. All resolution, identity checks, and decryption happen inside `CapturedRecord.decrypt(key)`. That means negative-test patterns stay symmetric: `await expect(handle.match(matcher).decrypt(key)).rejects.toMatchObject({ kind, reason })`.

The typechain does **not** attempt id-based auto-resolution. The on-chain `id` field is an identifier, not a unique-producer pointer — in nested call graphs the same id can appear in multiple places. Callers are responsible for selecting the source transition.

Selector failures produce `IdOnlyRecordResolutionError` with a narrow `reason` discriminator: `"transition-not-found" | "transition-not-unique" | "transition-index-out-of-range" | "transition-match-index-out-of-range" | "program-mismatch" | "not-a-ciphertext"`. The `program-mismatch` arm populates `expectedProgram` and `actualProgram` so the diagnostic is precise.

Matchers come from three sources:
- **Dynamic-record helpers** (`asGoldToken`, `asSilverToken`, …) emit an `.output` property carrying a `RecordOutputMatcher<T>` tied to the helper's `sourceRecord`. Useful for callers passing dyn-record arguments who then want to refine an external-record or sibling-concrete result against the same record type.
- **Imported external records** emit a sibling `<ExternalRecord>.output` value binding (e.g. `GoldToken_Token.output`) alongside the imported type, so cross-program callers can decrypt without re-stating the deserializer.
- **Unresolved external types** (no ABI available at codegen time): the codegen falls back to `IdOnlyExternalRecordHandle<LeoDynamicRecord>` and emits no typed helper or matcher. Callers construct a matcher at the call site via the public `createRecordOutputMatcher<MyShape>({ program, recordName, deserialize })` factory and chain `.from` or `.at` as usual.

`EncryptedRecord<T>` also exposes `.match(matcher)`, which re-routes decryption through the matcher's deserializer. It is symmetric with the id-only arms but enforces an **identity guard** at decrypt time: the matcher's `program` and `recordName` must equal the encrypted record's own metadata, otherwise `.decrypt()` async-throws `TransactionShapeError`. This prevents accidentally deserializing a GoldToken ciphertext through the SilverToken matcher.

`examples/aleo-ports/dynamic_records` exercises each handle type:

- **External `Record`**: `external_token_demo::wrap_mint_gold` returns `gold_token.aleo::Token`, decrypted from the callee `mint` transition via `GoldToken_Token.output.from("mint", 0)`.
- **Concrete record**: `external_token_demo::dispatch_and_receipt` (which spends a `dyn record` input through the token `transfer`) and `issue_receipt` (which mints internally) emit a concrete local `Receipt`, decryptable directly from the returned `EncryptedRecord<Receipt>`.
- **`dyn record`**: `token_router.aleo`'s `route_transfer` / `demo_transfer` return `dyn record`; clients recover the spendable sibling token via `accepted.outputs.match(asGoldToken.output.from("transfer", 0)).decrypt(key)`.

For the token and router program shapes and the V15 rule that requires the sibling materialization, see [`research/dynamic-records-v15.md` § LionDen Example And Typechain Surface](research/dynamic-records-v15.md#lionden-example-and-typechain-surface).

## Building and recovering dynamic records (Leo v4 `dyn record`)

For transitions whose Leo signature accepts `dyn record`, build the input with `Leo.dynamicRecord(value, schema)`. The schema is compile-time-validated via a `${LeoPrimitiveType}.${LeoVisibility}` template-literal union:

```ts
const tokenInput = Leo.dynamicRecord(
  { owner: Leo.address(addr), amount: 100n, _nonce: Leo.group("0group"), _version: 0 },
  {
    owner: "address.private",
    amount: "u128.private",
    _nonce: "group.public",
    _version: "u8.public",
  },
);
await amm.add_liquidity.locally(tokenInput, /* ... */);
```

Values are range-checked at runtime (integer bit-widths, address prefix, etc.). Missing or extra keys vs. the schema throw `TransitionInputError` with the offending key listed. The raw string escape hatch `Leo.unsafe.dynamicRecord("{ owner: ... }")` remains available for pre-built literals.

For repeated conversions from a generated concrete record type, prefer a `codegen.dynamicRecords` helper such as `asGoldToken(token)` over retyping the schema at every call site. Pass the original decrypted record: copies made with object spread, `structuredClone`, or a JSON round-trip lose the cached plaintext and its `_version` metadata. See [§ Interface conversion helpers](#interface-conversion-helpers) and `examples/aleo-ports/dynamic_records`.

On the output side, the same helper exposes a `.output` matcher (a `RecordOutputMatcher<T>`). Prefer generated matchers (`asGoldToken.output`, `GoldToken_Token.output`) over inline matcher construction; pass them to `accepted.outputs.match(matcher).decrypt(key)` to recover a record from any of the three handle types:

```ts
// Direct ciphertext: identity guard checks program/recordName.
const tok = await mint.outputs.match(asGoldToken.output).decrypt(alice());

// Dyn-record handle: bind the callee transition.
const transferred = await routed.outputs
  .match(asGoldToken.output.from("transfer", 0))
  .decrypt(alice());

// External-record handle: bind the callee transition by name.
const wrapped = await accepted.outputs
  .match(GoldToken_Token.output.from("mint", 0))
  .decrypt(bob());
```

`.match()` only records the binding; validation, source resolution, and decryption all run in `.decrypt(key)`. For `{ match: n }` disambiguation, positional `.at(...)` binding, matchers for unresolved external records, and the error taxonomy, see [§ Id-only record outputs](#id-only-record-outputs-dyn-record-and-external-record).
