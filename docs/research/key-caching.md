# Proving-Key Caching: Design Notes

When to read this: use this file for the rationale behind LionDen's key-cache layout, what is and isn't persisted, and why compile-time pre-warm is intentionally deferred. For end-user behavior of the SDK key cache config, use [`../network.md`](../network.md). For the compiler's sidecar emission, use [`../compiler.md`](../compiler.md).

## What ships today

LionDen persists proving-key material in three coordinated places, all opt-in via:

```ts
sdk: {
  keyCache: { storage: "filesystem" },
}
```

Default filesystem location is `artifacts/.cache/provable-keys/.aleo` (`packages/core/src/config-resolution.ts`). The three caches:

### 1. Runtime per-transition execution-key cache

Source: `packages/network/src/execution-key-cache.ts`.

Identity is circuit-based:

```
(network, programId, transition, edition?, sourceHash, importsHash, wasmHash)
```

— where `sourceHash` is the SHA-256 of the resolved program source (local artifact preferred, network fallback), `importsHash` is a SHA-256 over the sorted import graph, and `wasmHash` is the SHA-256 of the loaded `@provablehq/wasm` artifact for the active network. Execution inputs are intentionally **not** part of identity; the resulting key is a property of the circuit, not the call.

Layout on disk:

```
<keyCache.path>/lionden-runtime/<sha256(identity)>/
  prover.key
  verifier.key
  metadata.json     # RuntimeKeyCacheMetadata (format: "lionden.runtimeKeyCache.v1")
```

Atomic writes (temp+rename), fingerprint verification on read (size + SHA-256), reject-on-mismatch. The cache populates lazily — written after the first successful synthesis through `synthesizeAndCacheExecutionKeys` in `packages/network/src/connection.ts`.

### 2. Compile-time sidecar `lionden-key-artifacts.json`

Source: `packages/leo-compiler/src/compiler.ts` (`buildKeyArtifactsMetadata`); record format in `packages/core/src/key-artifacts.ts` (`format: "lionden.keyArtifacts.v1"`).

The sidecar is written per program under `artifacts/<programId>/lionden-key-artifacts.json` after each `leo build` succeeds. It carries:

- `programId`
- `sourceHash` (SHA-256 of `main.aleo`)
- `importsHash` (SHA-256 over the sorted, hashed imports tree)
- `functions[]` — optional per-transition `prover` / `verifier` refs, populated **only** when Leo emits a `.prover` + `.verifier` pair that can be unambiguously associated with the transition (`findUnambiguousKeyStem` in the compiler).

Today Leo v4 does not emit key files alongside `leo build`, so in practice `functions[]` is empty for current Leo versions. The sidecar is still emitted because (a) it pins identity for downstream consumers and (b) the field is forward-compatible: if a future Leo version emits paired key files, they flow into the cache through this channel with no LionDen code change.

The runtime cache consults the sidecar first (`readSidecarKeys` in `packages/network/src/execution-key-cache.ts`), then falls back to its own per-identity directory, then to SDK synthesis.

### 3. `credits.aleo` fee-key warmup + write-back

Source: `packages/network/src/sdk-adapter.ts` (`warmupFeeKeys`, `PersistentFunctionKeyProvider`).

Two paths:

- **Warmup-on-init.** When `keyCache.storage === "filesystem"` and `createSdkObjects` runs, LionDen reads `<keyCache.path>/lionden-credits/<wasmHash>/<network>/<base64url(locator)>.prover` + `.metadata.json` for each of `fee_public` / `fee_private`, verifies the metadata fingerprint, deserializes through `sdk.ProvingKey.fromBytes`, and primes the SDK's `AleoKeyProvider` cache via the public `cacheKeys()` API. The SDK's own fee-key code path then returns from cache without a network fetch.
- **Write-back-after-fetch.** When the cache is cold (or stale `wasmHash`), the SDK fetches the fee proving key. `PersistentFunctionKeyProvider.feePublicKeys/feePrivateKeys` intercepts the result and persists the bytes to disk for the next process.

Identity for fee keys is `(locator, network, wasmHash)`. Verifying keys are never persisted — they're reconstructed for free from WASM-bundled credits metadata on every warmup.

## Lookup order

For a proven execution (`packages/network/src/connection.ts` → `getPersistentExecutionOptions`):

1. **Sidecar refs** — when the program's `lionden-key-artifacts.json` declares matching `.prover` + `.verifier` files in the artifact directory and both file fingerprints verify, use them.
2. **Runtime cache** — match on the full circuit identity, verify both file fingerprints, use them.
3. **SDK synthesis** — call `ProgramManagerBase.synthesizeKeyPair(...)`, then atomically write back to (2). Execute the transition with the freshly synthesized keys injected.

Source/imports/wasm hash changes invalidate the cache as expected: a recompiled program with the same id but a changed circuit gets a new identity hash and re-synthesizes on next call.

For a fee transaction (`credits.aleo/fee_public` or `credits.aleo/fee_private`):

1. **Warmup-on-init** primes the SDK provider cache from disk.
2. **SDK** uses its own resolution path (now hot in process memory).
3. On cache miss, **write-back-after-fetch** persists for the next process.

Cross-reference: [`../network.md`](../network.md) walks the same flow from the user-facing angle in its SDK key-cache section.

## What isn't persisted by LionDen

From [`../network.md`](../network.md)'s filesystem key-cache behavior table and SDK-controlled path notes:

- **Deploy / upgrade program keys.** Not persisted by LionDen v1; SDK manages its own.
- **Translation keys.** SDK exposes metadata but no public execution-injection hook, so LionDen has no path to persist them.
- **Non-fee `credits.aleo` functions** (transfers, bonds, etc.). SDK's own fetch/cache behavior is in effect; LionDen does not intercept.

These rows are deliberate boundaries: LionDen persists where it owns the injection point, and stays out of the way where the SDK does. As the SDK grows public injection hooks, the persistence surface can grow with it.

## Deferred: compile-time pre-warm

The recurring question — and the one this doc exists to settle: should `compile` synthesize proving keys at compile time, so the first `--prove` run doesn't pay the synthesis cost?

The answer is "not until upstream changes," and the reason is concrete.

`ProgramManagerBase.synthesizeKeyPair(privateKey, source, functionId, inputs, imports?, edition?)` — see the SDK type declaration at `node_modules/@provablehq/wasm/dist/testnet/aleo_wasm.d.ts` — requires real per-transition `inputs`. The function is *circuit synthesis*, but the SDK currently entangles it with input-arrival semantics: inputs must be well-typed for the transition ABI and, for record-spending transitions, must include a valid `RecordPlaintext` with an owner address and a nonce.

Compile time has none of that:

- No signer — the compiler is invoked without a network or account context.
- No inputs — by definition the compiler runs before any call site exists.
- No mappings populated — anything the transition reads from on-chain state would have to be fabricated to satisfy synthesis.

A "pre-warm at compile" pass would therefore need a generic Leo-ABI fixture fabricator: for each transition, produce a synthetic but well-typed input vector, including records with valid owner addresses and any mapping entries the transition reads. For non-trivial programs that's effectively writing a property-based fuzzer for Leo ABIs — well outside the compile pipeline's scope, and architecturally cross-cutting (compiler would need a runtime/network dependency).

The runtime cache + write-back already amortizes synthesis cost:

- First call to a given `(network, programId, transition, edition, sourceHash, importsHash, wasmHash)` → synthesize and persist (~one-time cost per identity).
- Every subsequent call → cache hit, near-zero overhead.

Same end state a compile-time pre-warm would produce — except the runtime version is keyed by the real fingerprint of the circuit being proved, which is honest about what was synthesized.

The only scenario where a compile-time pre-warm would pay off is **the very first run on a clean checkout**. That's a CI-cache concern, not a framework concern: cache `artifacts/.cache/` between CI runs and the same amortization applies.

## What would unblock it

An upstream SDK API that decouples synthesis from input materialization — for example, a content-hash-keyed `synthesizeKeyPairFromSource(source, functionId, imports?, edition?)` that derives the circuit from the program text alone and returns cacheable bytes. The cache identity LionDen already computes (`sourceHash` + `importsHash` + circuit-relevant fields) is the natural key.

The deferred `_docs/research/leo_keys_caching.md` (local-only research notes from the original SDK survey) outlines the upstream gap; the recommended action is an upstream issue/PR on `ProvableHQ/sdk` rather than a downstream workaround. Until that lands, the runtime path is the right level of abstraction.

## Summary

| Cache | Identity | Where | When written |
| --- | --- | --- | --- |
| Runtime execution-key | `(network, programId, transition, edition?, sourceHash, importsHash, wasmHash)` | `<keyCache.path>/lionden-runtime/<sha256(identity)>/` | After first synthesis at proven call time |
| Compile-time sidecar | `(programId, sourceHash, importsHash)` + paired `.prover` / `.verifier` refs | `artifacts/<programId>/lionden-key-artifacts.json` | Every `leo build` success |
| `credits.aleo` fee key | `(locator, network, wasmHash)` | `<keyCache.path>/lionden-credits/<wasmHash>/<network>/<base64url(locator)>.prover` | Warmup-on-init read, write-back-after-fetch on cold |

Compile-time pre-warm of user-program proving keys: deferred, blocked on upstream SDK API.
