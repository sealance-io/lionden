# Network

When to read this: use this file for network config types, connection management, devnode lifecycle, SDK integration, transaction confirmation, and script execution. For deploy, upgrade, export, and deployment state, use [`deployment.md`](deployment.md).

## Current Network Model

`packages/config/src/types.ts` defines two network config variants:

- `devnode`
- `http`

Resolved config stores them under `config.networks` and selects one through `config.defaultNetwork` unless the CLI or task overrides it.

Current defaults include an implicit `devnode` network when the user does not configure any networks.

## Platform Baseline

LionDen uses `devnode` as its built-in lightweight local development target and `http` for connecting to any external network, local or remote.

The framework is intentionally devnode-first. That assumption shapes the default network behavior, the test helpers, and the task surface. Users who need a multi-validator network can run one externally and connect through an `http` network entry.

## Network Manager

`packages/network/src/network-manager.ts` provides `NetworkManagerImpl`, which is injected into the LRE by `@lionden/plugin-network`.

Current responsibilities:

- connect to a named network and reuse active connections
- resolve named accounts for the connected network (via `NamedAccountManager`) and cache them per network name
- expose the active connection
- expose named accounts for the active network (`getNamedAccounts()` returns a shallow copy)
- disconnect all open connections and clear named account state
- expose devnode accounts
- proxy `execute()` and `getMappingValue()` to the active connection

`connect()` is transactional: if named-account resolution fails after a new connection is created, only the new connection is closed and the previous active connection and named accounts are preserved. Switching back to a previously-connected network restores named accounts from the per-network cache without re-resolving.

Connection creation currently maps:

- `devnode` to `http://<socketAddr>`
- `http` to the configured endpoint

`packages/network/src/connection.ts` provides `AleoConnection`, including REST/SDK-backed helpers for execution, mapping reads, balance checks, block height, transaction broadcasting, transaction confirmation, and deployed program source fetching.

`NetworkConnection.getProgramSource(programId)` returns compiled Aleo source for deployed programs and `null` for missing programs. Deployment preflight, deployment-state validation, and compiler network dependency fetching rely on this behavior.

### `execute()` and transition outputs

`connection.execute(programId, transitionName, args, options?)` is the low-level imperative path. In `mode: "local"` it returns the SDK's local execution outputs synchronously. In on-chain mode (the default) it broadcasts the transaction and returns `{ outputs: [], txId }` — **fire-and-forget by default**, to preserve the typechain `submitTransition()` path's expectation that `.submitted()` doesn't wait and `.accepted()` / `.settled()` run their own confirmation poll.

Two ways to recover outputs after on-chain broadcast:

- **Opt in at call time**: pass `{ awaitConfirmation: true }`. `execute()` awaits confirmation, picks the matching `(programId, transitionName)` transition from `transitions[]`, and returns `{ outputs, rawOutputs, txId }`. Throws `TransitionRejectedError` if the transaction was confirmed as fee-only / rejected, and `TransitionSelectionError` if zero or more than one transitions match (reentrant flows — see the escape hatch below).
- **Fetch later**: call `connection.getTransitionOutputs(txId, programId, transitionName, timeout?)`. Same return shape and error semantics as the `awaitConfirmation: true` path. Useful when the caller broadcast many transitions in parallel and wants to resolve outputs after the fact.

`TransitionCallResult.outputs` stays `string[]` for ergonomic ABI deserializers (e.g. `Leo.u32(result.outputs[0])`). Id-only dynamic-record outputs are surfaced as their `id` string in `outputs`; the faithful on-chain shape (with the `idOnly` discriminator) is preserved separately in `TransitionCallResult.rawOutputs`.

User-facing wrappers (`ctx.execute`, `ctx.raw.execute`, the recipe `DeploymentContext.execute`) flip the default to `awaitConfirmation: true` at their layer. The reentrant escape hatch for those callers is `{ awaitConfirmation: false }` followed by `connection.waitForConfirmation(txId)` to inspect all transitions directly.

## Devnode Lifecycle

`packages/network/src/devnode-manager.ts` wraps `leo devnode start`.

Current behavior:

- spawns `leo devnode start`, or the binary specified by `leoBinary` in config
- supports socket address, auto-block, verbosity, genesis path, network selection, private key, and `consensusHeights`
- polls the REST API until healthy
- stops the process with graceful shutdown, then force kill on timeout

`consensusHeights` is required for Leo v3.5 devnode constructor programs. Leo v4 devnode defaults to V9-active. See [`leo-version-compatibility.md`](leo-version-compatibility.md).

`@lionden/plugin-network` exposes devnode startup through the `node` task.

Current `node` task flags:

- `--port`
- `--manual-blocks`
- `--quiet`
- `--network`

The task keeps the process alive until either Ctrl-C / SIGTERM (clean exit) or the devnode itself exits unexpectedly (in which case the task exits non-zero so wrapper scripts see the failure).

### Devnode log mode

`DevnodeManager.start({ logMode })` selects how the devnode subprocess's stdout/stderr are handled. Both piped streams are always drained — never left attached without a consumer — to avoid a pipe-fill stall under heavy log output.

| `logMode`        | Behavior                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `quiet-buffered` | (default for managed/test) Drain both, retain last 64 KiB per stream in a ring buffer. Surfaced in `getLogTail()` and in error messages on health-check timeout, unexpected exit, and the unexpected-exit diagnostic written to `process.stderr`. |
| `inherit`        | (default for `lionden node`) Pass stdout/stderr straight through to the parent process's stdio.                                |
| `forward`        | Drain in JS, invoke `onStdout` / `onStderr` per chunk, AND retain the same 64 KiB ring buffer.                                 |

Set `LIONDEN_DEVNODE_LOGS=inherit` (or `=1`) to surface devnode logs from managed test devnodes without editing code; `=forward` writes each chunk to `process.stderr` prefixed with `[devnode] `. Precedence is strict: **explicit caller `logMode` wins over the env var, env wins over default.** That means `lionden node --quiet` (which sets `logMode: "quiet-buffered"` explicitly) is still quiet even when `LIONDEN_DEVNODE_LOGS=inherit` is set.

If the devnode exits unexpectedly after `start()` resolves, `DevnodeManager` writes a one-line diagnostic to `process.stderr` including the buffered stderr tail (or, in `inherit` mode, a pointer to the terminal logs above). This converts a silent hang on subsequent broadcasts into a visible cause-of-failure. Programs that need to react to the exit can `await manager.waitForExit()` instead.

At the platform level, devnode and snarkOS nodes expose the same REST surface for blocks, transactions, programs, mappings, and block height. LionDen uses network endpoints both for runtime interaction and for fetching deployed program sources as compiler dependencies.

## Runtime Imports For Dynamic Dispatch

Leo v4 supports runtime dynamic dispatch via `Interface@(target)::fn(...)`, where the target program is selected by an `identifier` value at execute time. The SDK/VM cannot discover those targets from the dispatching program's static `import` statements, so LionDen exposes a layered "runtime imports" surface that threads the additional program sources into every execution path (`pm.run` for local mode, `buildDevnodeExecutionTransaction` for the devnode fast-path, and `pm.execute` for the standard/proven path).

Three layers, all additive (deduped by canonical id and absolute path, sorted for cache identity stability):

1. **Config defaults** — `config.execution.imports[programId]` (project-wide).
2. **Instance-level** — `createGovernance({ imports: [...] })` on the generated wrapper.
3. **Per-call** — `options.imports` on `.accepted()` / `.locally()` / `.settled()` / etc., and on raw `connection.execute(..., { imports })`.

Each entry is one of:
- a bare Leo program name (`"voting_power"` → normalized to `voting_power.aleo`)
- an explicit program id (`"voting_power.aleo"`)
- a path to a local `.aleo` file (relative paths anchor to the project root; `~` expands to the user's home directory)

Path refs must exist on disk — missing files raise a config error rather than falling through to network fetch. Program-id refs follow the existing artifacts-first / network-fallback chain used by static imports. Two refs that resolve to the same canonical program id but different source content throw a conflict error with both ref origins listed.

Runtime imports contribute to `importsHash` in the proving-key cache identity, so introducing a new dispatch target invalidates any cached keys for the dispatching program on first execute and re-caches under the new identity.

Runtime imports are **execution-time** dependencies only, not deploy-time deps. The compiler's static-import-based dependency resolver does not follow them, so a dispatch hub's strategy programs must be deployed explicitly (or pulled in via the normal `import` graph elsewhere). See `examples/aleo-ports/dynamic_dispatch` for config-level defaults and `examples/aleo-ports/dynamic_records` for wrapper instance imports plus per-call imports.

### Id-only record outputs (`dyn record` and external `Record`)

Two output shapes the Aleo REST layer exposes id-only on the surfacing transition — the typechain surfaces them as honest, distinct handle types rather than a `EncryptedRecord<T>` that would crash on access:

- **`dyn record` outputs** → `IdOnlyDynamicRecordHandle`. Carries id + `transitions` callgraph for inspection, plus `decryptFrom(projector, key, source)` for recovering a sibling concrete record materialized by a V15-compliant callee. The chain never exposes a ciphertext for the `record_dynamic` id itself — not on the caller's transition, not on the producing transition — so `decryptFrom` does **not** dereference the dynamic id. It targets an explicit sibling output, typically the static record that snarkVM's `ensure_records_exist` rule forces a V15-compliant transfer to emit alongside the dynamic handle (see [`research/snarkvm-record-existence.md`](research/snarkvm-record-existence.md)). For pre-V15 programs that cast and drop their static record, no such sibling exists and `decryptFrom` raises `not-a-ciphertext` — the honest answer for a program that has no recoverable record anywhere on the chain.
- **External `Record` outputs** → `IdOnlyExternalRecordHandle<T>` with `.decryptFrom(projector, key, source)`. The ciphertext lives on the **callee** transition (the imported program's transition that actually emitted the record), so the caller picks the source explicitly:
  - Named selector: `{ programId, transitionName, outputIndex, transitionMatchIndex? }` (`transitionMatchIndex` required when match count > 1).
  - Positional selector: `{ transitionIndex, outputIndex }` — DokoJS-style direct index into `transitions[i].rawOutputs[j]`.

The typechain does **not** attempt id-based auto-resolution. The on-chain `id` field is an identifier, not a unique-producer pointer — in nested call graphs the same id can appear in multiple places. Callers are responsible for selecting the source transition.

Selector failures produce `IdOnlyRecordResolutionError` with a narrow `reason` discriminator: `"transition-not-found" | "transition-not-unique" | "transition-index-out-of-range" | "transition-match-index-out-of-range" | "program-mismatch" | "not-a-ciphertext"`. The `program-mismatch` arm populates `expectedProgram` and `actualProgram` so the diagnostic is precise.

Projectors come from two sources:
- **Dynamic-record helpers** (`asGoldToken`, `asSilverToken`, …) emit a `.asOutput` property carrying a `DynamicRecordOutputProjector<T>` tied to the helper's `sourceRecord`. Useful for callers passing dyn-record arguments who then want to refine an external-record result against the same record type.
- **Imported external records** emit a sibling `<ExternalRecord>.asOutput` value binding (e.g. `GoldToken_Token.asOutput`) alongside the imported type, so cross-program callers can decrypt without re-stating the deserializer.

For programs with unresolved external types (no ABI available at codegen time), the codegen falls back to `IdOnlyExternalRecordHandle<LeoDynamicRecord>` — callers supply their own `DynamicRecordOutputProjector<TOut>` at the call site with a custom deserializer.

`examples/aleo-ports/dynamic_records/programs/external_token_demo/main.leo` is the canonical example: `wrap_mint_gold` returns `gold_token.aleo::Token` (external `Record`, decryptable from the callee `mint` transition); `issue_receipt` and `dispatch_and_receipt` accept `dyn record` inputs and emit a concrete local `Receipt` (decryptable directly). The token programs (`gold_token`, `silver_token`) implement `transfer` with the V15-compliant `(Token, dyn record)` tuple return so the static record is materialized at output index 0 of the callee transition. The router program's `route_transfer` / `demo_transfer` return `dyn record` (the dispatched dynamic surface), and clients recover the spendable sibling token via `decryptFrom(asGoldToken.asOutput, key, { programId: "gold_token.aleo", transitionName: "transfer", outputIndex: 0 })`.

## Provable SDK Integration

`packages/network/src/sdk-adapter.ts` is the single point of contact with `@provablehq/sdk`. It loads the SDK module dynamically on first use and initializes the WASM thread pool once per process. Other network and deploy code imports helpers from that module rather than touching the SDK directly.

### SDK Objects

`createSdkObjects()` constructs the full SDK object set for a connection: `Account`, `AleoNetworkClient`, `AleoKeyProvider`, `NetworkRecordProvider`, and `ProgramManager`.

When a task supplies a custom signer key, `createSignerSdkObjects()` builds an isolated `Account`, `ProgramManager`, and `NetworkRecordProvider` for that signer while sharing the key provider with the default connection.

SDK proving-key caching defaults to filesystem-backed execution key persistence:

```ts
sdk: {
  keyCache: { storage: "filesystem" },
}
```

Projects that need process-local SDK caching only can opt out with `sdk.keyCache.storage = "memory"`.

The default filesystem location is `artifacts/.cache/provable-keys/.aleo`. Custom paths are resolved from the project root unless absolute; when the final path segment is not `.aleo`, LionDen treats the effective path as `<path>/.aleo`, matching the SDK `LocalFileKeyStore` convention.

Filesystem key persistence covers LionDen-managed proven execution transition keys and the supported SDK fee keys (`credits.aleo/fee_public`, `credits.aleo/fee_private`):

| Path | Filesystem key cache behavior |
| --- | --- |
| On-chain execute with proof generation | cached and injected |
| Devnode execute without `prove: true` | not used; devnode fast path skips proofs |
| Local `mode: "local"` execution | not used |
| SDK fee keys such as `credits.aleo/fee_public` | persisted under `lionden-credits/<wasmHash>/<network>/<encoded-locator>.prover`; warmup-on-init populates the SDK key provider cache, write-back-after-fetch persists proving-key bytes on first use |
| Deploy / upgrade program keys | not persisted by LionDen v1 |
| Translation keys | not persisted by LionDen v1 |

Runtime execution key identity is circuit-based: network, program id, transition, edition when available, local or fetched program source hash, import source hash, and the actual `@provablehq/wasm` artifact SHA-256. Execution inputs are intentionally excluded. SDK and WASM package versions are stored as diagnostics only.

Lookup order for proven executions is:

1. compiler sidecar refs to existing `.prover` / `.verifier` files when both files exist and fingerprints match
2. LionDen's runtime synthesis cache under the configured key-cache path
3. LionDen synthesis through the SDK-resolved WASM `ProgramManagerBase` on miss, followed by an atomic runtime-cache write and execution with injected proving/verifying keys

LionDen resolves program source and imports from local artifacts first, falling back to the connected network, and passes the resolved import graph to both synthesis and execution. SDK-controlled paths outside the transition-key cache that LionDen does *not* persist — deploy/upgrade transaction building, translation keys, and non-fee credits.aleo functions such as transfers and bonds — still use the SDK's own fetch/cache behavior.

Fee-key persistence (`credits.aleo/fee_public`, `credits.aleo/fee_private`) is keyed by the SDK locator, the runtime `@provablehq/wasm` SHA-256, and the network. On startup, LionDen reads any on-disk proving-key bytes that match the fingerprint in the sibling `.metadata.json`, deserializes them through `sdk.ProvingKey.fromBytes`, and pre-populates the SDK's `AleoKeyProvider` cache via the public `cacheKeys()` API — so the SDK's own fee-key code path returns from cache without a network fetch. The first time the SDK does fetch (cold cache, or stale wasmHash), `PersistentFunctionKeyProvider.feePublicKeys/feePrivateKeys` writes the bytes back to disk for the next process. Verifying keys are never persisted; they come from the WASM-bundled credits.aleo metadata and are reconstructed for free on each warmup.

Translation keys are not persisted yet because the current SDK exposes metadata but no public execution injection hook.

### Transaction Building And Broadcasting

The SDK exposes two families of transaction builders: standard methods for real networks and `buildDevnode*` variants that skip proof generation for local development speed. LionDen branches on `connection.type` at every transaction entry point:

| Operation | HTTP network | Devnode |
| --- | --- | --- |
| Deploy | `pm.deploy()` - atomic build + broadcast | `pm.buildDevnodeDeploymentTransaction()` + `broadcastTransaction()`; with `prove: true`, `pm.buildDeploymentTransaction()` + `broadcastTransaction()` |
| Execute | `pm.execute()` - atomic build + broadcast | `pm.buildDevnodeExecutionTransaction()` + `broadcastTransaction()`; with `prove: true`, `pm.execute()` |
| Upgrade | `pm.buildUpgradeTransaction()` + `broadcastTransaction()` | `pm.buildDevnodeUpgradeTransaction()` + `broadcastTransaction()`; with `prove: true`, `pm.buildUpgradeTransaction()` + `broadcastTransaction()` |

`pm.deploy()` and `pm.execute()` are atomic on HTTP networks: they build and submit the transaction internally with no separate broadcast step. Upgrade uses build-then-broadcast on both network types.

`broadcastTransaction()` on `AleoConnection` delegates to `AleoNetworkClient.submitTransaction()` from the SDK, so devnode broadcasts and HTTP upgrade broadcasts go through the same SDK path.

### Devnode Guards

Before devnode fast-path transactions are built, two SDK checks run:

- `checkDevnodeSdkSupport()` verifies that the loaded SDK exposes `buildDevnodeDeploymentTransaction`, `buildDevnodeExecutionTransaction`, and `buildDevnodeUpgradeTransaction`.
- `initConsensusHeights()` calls `sdk.getOrInitConsensusVersionTestHeights()` to prime the SDK's internal consensus version state. This is required for devnode transaction builders and is non-fatal if the method is absent in older SDK versions. Devnode `prove: true` deploy/upgrade skips `checkDevnodeSdkSupport()` because it does not call the `buildDevnode*` methods, but still initializes consensus heights.

### Transaction Confirmation

After broadcasting, LionDen polls `GET /{networkId}/transaction/confirmed/{txId}` directly through `fetch` rather than through the SDK. The block height is resolved in a second phase via `GET /{networkId}/find/blockHash/{txId}` followed by `GET /{networkId}/block/{blockHash}`, reading `header.metadata.height`. Polling runs at one-second intervals up to `config.deploy.confirmationTimeout`, defaulting to 60 seconds.

The `--skip-confirm` flag on `deploy` and `upgrade` bypasses this step.

## Script Execution

The `run` task in `packages/plugin-network/src/index.ts` executes a TypeScript script with the LRE.

Current flow:

1. resolve the target network and connect
2. resolve the script path relative to the project root
3. import the module dynamically
4. call its `default` export if present, otherwise `main`, otherwise rely on side effects

This is the path used by the example deployment scripts.

## Config Validation

`@lionden/plugin-network` adds validation relevant to network behavior:

- default network must exist
- HTTP networks must specify an endpoint

Deploy-specific validation is documented in [`deployment.md`](deployment.md).

## Design Direction

For the broader network abstraction, devnode-first rationale, and SDK baseline, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the current network package and plugin source for the implementation contract that exists today.
