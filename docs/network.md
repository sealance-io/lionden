# Network

When to read this: use this file for network config types, connection management, devnode lifecycle, SDK integration, transaction confirmation, and script execution. For deploy, upgrade, export, and deployment state, use [`deployment.md`](deployment.md).

## Current Network Model

`packages/config/src/types.ts` defines two network config variants:

- `devnode`
- `http`

Resolved config stores them under `config.networks` and selects one through `config.defaultNetwork` unless the CLI or task overrides it. See [Network Selection And The Worker Bridge](#network-selection-and-the-worker-bridge) for how `--network` flows from the CLI into Vitest worker test contexts.

Current defaults include an implicit `devnode` network when the user does not configure any networks.

## Network Selection And The Worker Bridge

The active network is resolved in this order:

- **CLI `--network <name>`** is a built-in global. The CLI validates it against `config.networks`, mutates `config.defaultNetwork` for the in-process run, and seeds it into `globalOptions["network"]`. Every task except `test` reads the mutated `config.defaultNetwork` directly.
- **`test --network <name>`** additionally bridges the selection to Vitest worker processes via the `LIONDEN_NETWORK` env var (alongside `LIONDEN_PROJECT_ROOT` and `LIONDEN_PROVE`). It is set only when `--network` was supplied, so default runs leave it unset. Each worker's LRE (`@lionden/testing` `buildLre()`) retargets `config.defaultNetwork` to the bridged name — validated, with an unknown name throwing a clear error — so worker `setup()` contexts target the same network the CLI selected. A per-call `setup({ network })` still wins over the bridged default.
- **Programmatic `tasks.run("deploy"/"recipe"/"upgrade", { network })`** retargets that single task's connect/deploy step **and** the implicit compile it triggers. The task forwards the requested network into compile as an internal passthrough arg, so `compilePipeline` resolves network-dependency fetches (`GET /{network}/program/{id}`) and `.env` materialization for the deploying network rather than `config.defaultNetwork` — e.g. deploying to network `X` while the file default is devnode fetches imported on-chain sources from `X`. `network` is **not** a CLI flag (it is a reserved built-in global that mutates `config.defaultNetwork`); the forward is omitted on a default run, which stays byte-for-byte on `config.defaultNetwork`. An explicit network unknown to `config.networks` throws a clear validation error before any fetch.

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
- proxy `execute()`, mapping reads, and storage reads to the active connection

`connect()` is transactional: if named-account resolution fails after a new connection is created, only the new connection is closed and the previous active connection and named accounts are preserved. Switching back to a previously-connected network restores named accounts from the per-network cache without re-resolving.

Connection creation currently maps:

- `devnode` to `http://<socketAddr>`
- `http` to the configured endpoint

`packages/network/src/connection.ts` provides `AleoConnection`, including REST/SDK-backed helpers for execution, mapping reads, balance checks, block height, transaction broadcasting, transaction confirmation, and deployed program source fetching.

`NetworkConnection.getProgramSource(programId)` returns compiled Aleo source for deployed programs and `null` for missing programs. Deployment preflight, deployment-state validation, and compiler network dependency fetching rely on this behavior.

`NetworkConnection.getStorageValue(programId, variableName)` reads regular
`StorageType.Plaintext` storage through the lowered `<name>__` mapping at key `"false"`.
Vector storage uses explicit helpers instead: `getStorageVectorLength()` reads
`<name>__len__` at key `"false"` and returns `0` when absent, while
`getStorageVectorValue()` reads `<name>__` at key `"<index>u32"`.

### `execute()` and transition outputs

`connection.execute(programId, transitionName, args, options?)` is the low-level imperative path. In `mode: "local"` it returns the SDK's local execution outputs synchronously. In on-chain mode (the default) it broadcasts the transaction and returns `{ outputs: [], txId }` — **fire-and-forget by default**, to preserve the typechain `submitTransition()` path's expectation that `.submitted()` doesn't wait and `.accepted()` / `.settled()` run their own confirmation poll.

Two ways to recover outputs after on-chain broadcast:

- **Opt in at call time**: pass `{ awaitConfirmation: true }`. `execute()` awaits confirmation, picks the matching `(programId, transitionName)` transition from `transitions[]`, and returns `{ outputs, rawOutputs, txId }`. Throws `TransitionRejectedError` if the transaction was confirmed as fee-only / rejected, and `TransitionSelectionError` if zero or more than one transitions match (reentrant flows — see the escape hatch below).
- **Fetch later**: call `connection.getTransitionOutputs(txId, programId, transitionName, timeout?)`. Same return shape and error semantics as the `awaitConfirmation: true` path. Useful when the caller broadcast many transitions in parallel and wants to resolve outputs after the fact.

`TransitionCallResult.outputs` stays `string[]` for ergonomic ABI deserializers (e.g. `Leo.u32(result.outputs[0])`). Id-only dynamic-record outputs are surfaced as their `id` string in `outputs`; the faithful on-chain shape (with the `idOnly` discriminator) is preserved separately in `TransitionCallResult.rawOutputs`.

User-facing wrappers (`ctx.execute`, `ctx.raw.execute`, the recipe `DeploymentContext.execute`) flip the default to `awaitConfirmation: true` at their layer. The reentrant escape hatch for those callers is `{ awaitConfirmation: false }` followed by `connection.waitForConfirmation(txId)` to inspect all transitions directly.

## Devnode Lifecycle

`packages/network/src/devnode-manager.ts` drives a local devnode. It supports two backends:

- **`"leo"`** — the devnode bundled in the Leo CLI (`leo --disable-update-check devnode start`).
- **`"standalone"`** — Provable's standalone `aleo-devnode` binary (`aleo-devnode start`).

### Backend selection

The backend is chosen by `resolveDevnodeBackend` (`packages/network/src/devnode-backend.ts`):

- `networks.<name>.provider: "leo" | "standalone"` pins the backend.
- When `provider` is omitted, the backend is **auto-detected** at start time: if `aleo-devnode --version` runs, the standalone backend is used; otherwise it falls back to the Leo CLI. (If you have `aleo-devnode` installed but want the bundled devnode, pin `provider: "leo"`.)
- Standalone-only inputs — an explicit `binary`, `storagePath`, `clearStorageOnStart`, or the `--persist` flag — **force** the standalone backend. If it is unavailable (or `provider: "leo"` is pinned), startup fails with a clear error rather than silently dropping the feature.

The standalone backend is **TestnetV0-only**: a non-`testnet` `network` or any `consensusHeights` is rejected (at config validation for an explicit `provider: "standalone"`, and before spawn for the auto-detected case).

For the test runner's auto-started devnode (`@lionden/testing` `setup()`), the `LIONDEN_DEVNODE_BINARY=<path>` env var overrides the backend without editing the generated config: it points at a specific off-`PATH` `aleo-devnode` build, and because an explicit binary is a standalone-only input it forces the standalone backend on its own. It is read only by `setup()`; auto-detect remains the default mechanism. It selects *which* devnode runs — it does **not** grant permission to bind the REST port: a `Failed to bind TCP port … Operation not permitted` startup error is a host/sandbox restriction that affects either backend, so run the devnode where binding `127.0.0.1:3030` is allowed.

The Leo CLI backend also behaves as a testnet devnode in practice. On Leo **< 4.3**, LionDen's `network` field is retained for CLI compatibility and may be forwarded to `leo devnode start` when it is not `"testnet"`, but callers should not rely on Leo devnode as a real mainnet/canary/devnet simulator: changing the configured route name does not make the local chain mainnet/canary/devnet. `consensusHeights` applies to the Leo < 4.3 backend only. On Leo **4.3+**, `leo devnode start` no longer accepts `--consensus-heights` or `--network` (the devnode is TestnetV0-only and auto-activates the latest consensus version, incl. V16/V17), so LionDen omits both and rejects a `consensusHeights` / non-`testnet` `network` at config validation.

Leo 4.1 adds its own devnode persistence support, but LionDen does not enable or wrap it yet. Persistence and snapshot/restore remain standalone-backend-only in this repo.

Devnode network config fields:

| Field | Backend | Meaning |
| --- | --- | --- |
| `socketAddr`, `autoBlock`, `verbosity`, `genesisPath`, `privateKey` | both | REST bind address, block mode, log level, genesis, validator key |
| `network` | leo (< 4.3) | retained for Leo CLI compatibility; the managed Leo devnode still behaves as testnet. Leo 4.3+ is TestnetV0-only and rejects non-`testnet` |
| `consensusHeights` | leo (< 4.3) | consensus heights (Leo v3.5 constructor programs). Rejected on Leo 4.3+ (devnode auto-activates the latest consensus version) |
| `provider` | both | `"leo"` / `"standalone"` / omit for auto-detect |
| `binary` | standalone | path to the `aleo-devnode` binary (`leoBinary` is the Leo path) |
| `storagePath` | standalone | persistent RocksDB ledger dir (`--storage`); enables snapshot/restore |
| `clearStorageOnStart` | standalone | clear `storagePath` before start (`--clear-storage`); requires `storagePath` |

Common behavior: polls the REST API at `/<network>/block/height/latest` until healthy, then stops the process with graceful shutdown (SIGTERM) and a force-kill on timeout.

On Leo **< 4.3**, `consensusHeights` is required for Leo v3.5 devnode constructor programs on the Leo backend (Leo v4 devnode defaults to V9-active). On Leo **4.3+** the flag was removed — the devnode auto-activates the latest consensus version (incl. V16/V17), so LionDen rejects `consensusHeights` rather than dropping it. See [`leo-version-compatibility.md`](leo-version-compatibility.md).

### Persistence and snapshots (standalone)

When `storagePath` is set, the standalone devnode persists its ledger and `DevnodeManager` exposes snapshot/restore (capability-gated; throws on the Leo backend or in-memory standalone):

- `snapshot(name?)` → `POST /<network>/snapshot` (always sends a JSON body). Returns `{ name, height }`.
- `listSnapshots()` → `GET /<network>/snapshots`.
- `restore(name)` → offline flow: stop the devnode, run `aleo-devnode restore --snapshot <name> --storage <dir>` (the private key is forwarded via the `PRIVATE_KEY` env var, never argv), then restart with the original start options — except `clearStorage`, which is forced off so the restart can't wipe the ledger the restore just rebuilt. Restores **chain state only** — callers must invalidate their own deployment cache.

For snapshot-based fast reset in tests, see [`testing.md`](testing.md) (`setup({ snapshotReset: true })`).

### The `node` task

`@lionden/plugin-network` exposes devnode startup through the `node` task. Flags:

- `--port`
- `--manual-blocks`
- `--quiet`
- `--persist <dir>` — persist the ledger (forces the standalone backend)
- `--clear-storage` — clear the persist dir before start (requires `--persist`)

The task keeps the process alive until either Ctrl-C / SIGTERM (clean exit) or the devnode itself exits unexpectedly (in which case the task exits non-zero so wrapper scripts see the failure).

If a devnode child outlives its parent (hard-killed runner, force-quit IDE, crashed CI worker) it keeps holding the socket and the next start fails with `127.0.0.1:3030` already in use. See [`usage.md`](usage.md#troubleshooting) for the macOS `lsof`/`kill` recipe to find and clear the orphan.

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

1. **Config defaults** — `config.execution.imports[programId]` (project-wide), where `programId` is the runtime program being executed.
2. **Instance-level** — `createGovernance({ imports: [...] })` on the generated wrapper.
3. **Per-call** — `options.imports` on `.accepted()` / `.locally()` / `.settled()` / etc., and on raw `connection.execute(..., { imports })`.

Each entry is one of:
- a bare Leo program name (`"voting_power"` → normalized to `voting_power.aleo`)
- an explicit program id (`"voting_power.aleo"`)
- a path to a local `.aleo` file (relative paths anchor to the project root; `~` expands to the user's home directory)

Path refs must exist on disk — missing files raise a config error rather than falling through to network fetch. Program-id refs follow the existing artifacts-first / network-fallback chain used by static imports. Two refs that resolve to the same canonical program id but different source content throw a conflict error with both ref origins listed.

Runtime imports contribute to `importsHash` in the proving-key cache identity, so introducing a new dispatch target invalidates any cached keys for the dispatching program on first execute and re-caches under the new identity.

Runtime imports are **execution-time** dependencies only, not deploy-time deps. The compiler's static-import-based dependency resolver does not follow them, so a dispatch hub's strategy programs must be deployed explicitly (or pulled in via the normal `import` graph elsewhere). See `examples/aleo-ports/dynamic_dispatch` for config-level defaults and `examples/aleo-ports/dynamic_records` for wrapper instance imports plus per-call imports.

For renamed wrappers, config-level runtime imports are still keyed by the wrapper's effective runtime `programId`. `sourceProgramId` is compile/deploy provenance and is not used for execution-config lookup; if a renamed program should use the same runtime imports as its source program, declare those imports explicitly under the renamed runtime id.

### Id-only record outputs (`dyn record` and external `Record`)

Two output shapes the Aleo REST layer exposes id-only on the surfacing transition — the typechain surfaces them as honest, distinct handle types rather than an `EncryptedRecord<T>` that would crash on access:

- **`dyn record` outputs** → `IdOnlyDynamicRecordHandle`. Carries id + `transitions` callgraph for inspection, plus `.match(matcher.from(...))` / `.match(matcher.at(...))` to bind a source. The chain never exposes a ciphertext for the `record_dynamic` id itself — not on the caller's transition, not on the producing transition — so the match does **not** dereference the dynamic id. It targets an explicit sibling output, typically the static record that snarkVM's V15 record-existence rule requires a compliant transfer to emit alongside the dynamic handle. For pre-V15 programs that cast and drop their static record, no such sibling exists and `.decrypt()` raises `not-a-ciphertext` — the honest answer for a program that has no recoverable record anywhere on the chain.
- **External `Record` outputs** → `IdOnlyExternalRecordHandle<T>` with the same `.match(matcher).decrypt(key)` flow. The ciphertext lives on the **callee** transition (the imported program's transition that actually emitted the record), so the caller picks the source explicitly via:
  - `.from(transitionName, outputIndex, { match: n? })` — named binding. The matcher's `program` is inherited as the source `programId`, so callers cannot accidentally point at a different program by name. `{ match: n }` disambiguates when the same `(program, transitionName)` appears more than once.
  - `.at(transitionIndex, outputIndex)` — positional binding into `transitions[i].rawOutputs[j]`. Use this when name-based disambiguation is awkward (you'd rather index directly) or when authoring an intentional cross-program mismatch test. Successful decryption still requires the selected transition's `programId` to equal the matcher's `program` — any mismatch surfaces as `program-mismatch` from `.decrypt(key)`.

`.match(matcher)` is a pure builder — it captures intent without running any validation. All resolution, identity checks, and decryption happen inside `CapturedRecord.decrypt(key)`. That means negative-test patterns stay symmetric: `await expect(handle.match(matcher).decrypt(key)).rejects.toMatchObject({ kind, reason })`.

The typechain does **not** attempt id-based auto-resolution. The on-chain `id` field is an identifier, not a unique-producer pointer — in nested call graphs the same id can appear in multiple places. Callers are responsible for selecting the source transition.

Selector failures produce `IdOnlyRecordResolutionError` with a narrow `reason` discriminator: `"transition-not-found" | "transition-not-unique" | "transition-index-out-of-range" | "transition-match-index-out-of-range" | "program-mismatch" | "not-a-ciphertext"`. The `program-mismatch` arm populates `expectedProgram` and `actualProgram` so the diagnostic is precise.

Matchers come from three sources:
- **Dynamic-record helpers** (`asGoldToken`, `asSilverToken`, …) emit an `.output` property carrying a `RecordOutputMatcher<T>` tied to the helper's `sourceRecord`. Useful for callers passing dyn-record arguments who then want to refine an external-record or sibling-concrete result against the same record type.
- **Imported external records** emit a sibling `<ExternalRecord>.output` value binding (e.g. `GoldToken_Token.output`) alongside the imported type, so cross-program callers can decrypt without re-stating the deserializer.
- **Unresolved external types** (no ABI available at codegen time): the codegen falls back to `IdOnlyExternalRecordHandle<LeoDynamicRecord>`. Callers construct a matcher at the call site via the public `createRecordOutputMatcher<MyShape>({ program, recordName, deserialize })` factory.

`EncryptedRecord<T>` also exposes `.match(matcher)`. It is symmetric with the id-only arms but enforces an **identity guard** at decrypt time: the matcher's `program` and `recordName` must equal the encrypted record's own metadata, otherwise `.decrypt()` async-throws `TransactionShapeError`. This prevents accidentally deserializing a GoldToken ciphertext through the SilverToken matcher.

`examples/aleo-ports/dynamic_records/programs/external_token_demo/main.leo` is the canonical example: `wrap_mint_gold` returns `gold_token.aleo::Token` (external `Record`, decryptable from the callee `mint` transition); `dispatch_and_receipt` accepts a `dyn record` input (which it spends via `transfer`), `issue_receipt` mints a token internally, and both emit a concrete local `Receipt` (decryptable directly). The token programs (`gold_token`, `silver_token`) implement `transfer` with a concrete `Token` input and V15-compliant `(Token, dyn record)` tuple return, so the input is spent and the output static record is materialized at output index 0 of the callee transition. Their `balance_of(token: dyn record) -> u64` is a pure read, applied only to dynamic records produced inside the execution (the router and receipt flows mint before reading); a direct/root `balance_of` on a held token is rejected by V15. The router program's `route_transfer` / `demo_transfer` return `dyn record` (the dispatched dynamic surface), and clients recover the spendable sibling token via `accepted.outputs.match(asGoldToken.output.from("transfer", 0)).decrypt(key)`. See [`research/dynamic-records-v15.md`](research/dynamic-records-v15.md) for the V15 program-shape rule that requires this materialization.

## Provable SDK Integration

`packages/network/src/sdk-adapter.ts` is the single point of contact with `@provablehq/sdk`. It loads the SDK module dynamically on first use and initializes the WASM thread pool once per process. Other network and deploy code imports helpers from that module rather than touching the SDK directly.

### SDK Objects

`createSdkObjects()` constructs the full SDK object set for a connection: `Account`, `AleoNetworkClient`, `AleoKeyProvider`, `NetworkRecordProvider`, and `ProgramManager`.

When a task supplies a custom signer key, `createSignerSdkObjects()` builds an isolated `Account`, `ProgramManager`, and `NetworkRecordProvider` for that signer while sharing the key provider with the default connection.

SDK proving-key caching defaults to filesystem-backed execution key persistence:

```ts
sdk: {
  logLevel: "warn",
  keyCache: { storage: "filesystem" },
}
```

`sdk.logLevel` accepts `"silent"`, `"error"`, `"warn"`, `"info"`, or `"debug"` and defaults to `"warn"`. LionDen calls the SDK's `setLogLevel()` only when the installed SDK exposes it; the SDK setting is process-global, so the most recently initialized connection's level is the active one. Projects that need process-local SDK caching only can opt out with `sdk.keyCache.storage = "memory"`.

SDK bump maintenance: when `@provablehq/sdk` or `@provablehq/wasm` changes, re-audit the SDK/WASM console strings filtered by `packages/plugin-test/src/sdk-console-filter.ts` with a real prove run at `sdk.logLevel: "info"`. Also re-check the SDK parameter-host allowlist and devnode method guards in `packages/network/src/sdk-adapter.ts`.

The default filesystem location is `artifacts/.cache/provable-keys/.aleo`. Custom paths are resolved from the project root unless absolute; when the final path segment is not `.aleo`, LionDen treats the effective path as `<path>/.aleo`, matching the SDK `LocalFileKeyStore` convention.

Filesystem key persistence covers LionDen-managed proven execution transition keys and every named entry in the SDK's `CREDITS_PROGRAM_KEYS` map:

| Path | Filesystem key cache behavior |
| --- | --- |
| On-chain execute with proof generation | sidecar/runtime cache hits are injected; cache misses do **not** call eager `synthesizeKeyPair` and instead synthesize lazily inside `pm.execute` (not persisted); see the egress-policy carve-out below |
| Devnode execute without `prove: true` | not used; devnode fast path skips proofs |
| Local `mode: "local"` execution | not used |
| `credits.aleo` named keys (`fee_public`, `fee_private`, `inclusion`, `join`, `split`, `bond_public`, `bond_validator`, `unbond_public`, `claim_unbond_public`, `set_validator_state`, `transfer_*`) | persisted under `lionden-credits/<wasmHash>/<network>/<encoded-locator>.prover`; warmup-on-init populates the SDK key provider cache, write-back-after-fetch persists proving-key bytes on first use. `set_validator_state` is reached only via `functionKeys()` in the SDK; LionDen identifies it by `name`, `cacheKey: "credits.aleo/<entry>"`, or matching `proverUri` against `CREDITS_PROGRAM_KEYS` |
| `credits.aleo/functionKeys(search)` for non-credits locators (arbitrary user program keys) | not persisted by LionDen; the SDK handles its own in-memory caching |
| Deploy / upgrade program keys | not persisted by LionDen v1 |
| Translation keys | not persisted by LionDen v1 |

This expansion is a **performance** improvement: it keeps repeated prove runs from re-fetching every credits.aleo proving key the SDK touches. The egress policy below does not gate parameter downloads — those go through the SDK's known parameter hosts. When the SDK asks `parameters.provable.com` for a parameter artifact and that request throws or returns a non-OK response, LionDen retries the equivalent `s3.us-west-1.amazonaws.com/<network>.parameters/...` mirror before surfacing the primary failure. For hermetic / offline operation, pre-warm the filesystem key cache and then enforce no-network at the container / CI / firewall level; LionDen does not promise an in-process offline mode.

Runtime execution key identity is circuit-based: network, program id, transition, edition when available, local or fetched program source hash, import source hash, and the actual `@provablehq/wasm` artifact SHA-256. Execution inputs are intentionally excluded. SDK and WASM package versions are stored as diagnostics only.

Lookup order for proven executions is:

1. compiler sidecar refs to existing `.prover` / `.verifier` files when both files exist and fingerprints match
2. LionDen's runtime synthesis cache under the configured key-cache path
3. on a miss, LionDen returns only the program edition when available and lets `pm.execute` synthesize lazily through the SDK `CallbackQuery`; those runtime keys are not persisted on that call.

LionDen resolves program source and imports from local artifacts first, falling back to the connected network, and passes the resolved import graph to execution. SDK-controlled paths outside the transition-key cache that LionDen does *not* persist — deploy/upgrade transaction building and translation keys — still use the SDK's own fetch/cache behavior.

Credits-key persistence is keyed by the SDK locator, the runtime `@provablehq/wasm` SHA-256, and the network. On startup, LionDen reads any on-disk proving-key bytes that match the fingerprint in the sibling `.metadata.json`, deserializes them through `sdk.ProvingKey.fromBytes`, and pre-populates the SDK's `AleoKeyProvider` cache via the public `cacheKeys()` API — so the SDK's own credits-key code path returns from cache without a network fetch. The first time the SDK does fetch (cold cache, or stale wasmHash), `PersistentFunctionKeyProvider` writes the bytes back to disk for the next process. Verifying keys are never persisted; they come from the WASM-bundled credits.aleo metadata and are reconstructed for free on each warmup. The `transferKeys(visibility)` accessor maps every documented visibility string (`"private"`, `"transferPrivate"`, `"public"`, `"public_as_signer"`, `"transferPublicAsSigner"`, etc.) to its `transfer_*` credits entry before persisting; unknown visibility strings are passed through to the SDK and not persisted. `set_validator_state` is not exposed as a dedicated key-provider method by the SDK and is reached only through the generic `functionKeys()` path; the persistent wrapper identifies it (and any other credits entry routed the same way) by `name`, by `cacheKey: "credits.aleo/<entry>"`, or by matching `proverUri` against `CREDITS_PROGRAM_KEYS`, and persists by entry name. Non-credits `functionKeys()` calls (arbitrary user-program locators) are left untouched.

Translation keys are not persisted yet because the current SDK exposes metadata but no public execution injection hook.

### Egress Policy

LionDen installs a guarded `transport` on every `AleoNetworkClient` it constructs (standalone, `ProgramManager`-internal, per-signer copies). The transport restricts SDK chain-state and transaction-submission egress to an explicit per-connection allowlist, and — independently of egress filtering — flips the SDK's `hasCustomTransport` flag to `true`. That flag is load-bearing: with it set, the prove path routes `stateRoot` / `statePaths` / `latestHeight` lookups through a JS `CallbackQuery` whose host comes from the connection. Without it, WASM falls back to an internal SnapshotQuery bound to the WASM-baked `https://api.provable.com/v2` constant and leaks state queries to the public host.

This closes the leak on the **execute / prove** path (`pm.execute` → `buildExecutionTransaction`), where the SDK threads the `CallbackQuery` based on `hasCustomTransport`. It does **not** by itself cover the **eager key-synthesis** path: the WASM `synthesizeKeyPair` takes no query parameter, so it can bypass the transport entirely (the guard never sees it — it is a native WASM fetch, not a JS one). That second entry point is closed separately: LionDen never calls eager `synthesizeKeyPair` on a filesystem key-cache miss. Cache hits are still injected; misses defer to lazy `pm.execute` synthesis through the `CallbackQuery`. See § SDK Objects for the lookup order and `getPersistentExecutionOptions`.

**Scope.** The policy governs **network-host** fetches only — chain-state reads, transaction submission, anything `AleoNetworkClient` does. Parameter downloads (credits proving/verifying keys, KZG SRS) are governed by the SDK key cache and an **internal** known-host list (`parameters.provable.com`, `s3.us-west-1.amazonaws.com`, `parameters.aleo.org`); they are not user-configurable. For `parameters.provable.com` artifacts, LionDen can retry the matching S3 mirror when the primary fetch fails or returns non-OK. An unknown parameter host means LionDen's allowlist is stale relative to the installed SDK and surfaces as an actionable error.

**Defaults.** Same shape for every connection type — only the endpoint host varies:

| `type` | `allowedNetworkHosts` | `violation` |
| --- | --- | --- |
| `"devnode"` (managed) | `{ hostOf(socketAddr) }` | `"block"` |
| `"http"` (public testnet/mainnet or user-operated snarkOS) | `{ hostOf(endpoint) }` | `"block"` |

**`sdk.egress` override:**

```ts
sdk: {
  egress: {
    // Add hosts beyond the connection endpoint to the network allowlist
    // (telemetry, indexer sidecars, etc.).
    networkHosts: ["telemetry.example"],
    // "block" rejects disallowed network fetches with a hard error; "warn"
    // logs and forwards (useful for staged rollouts / debugging).
    violation: "warn",
  },
},
```

A blocked network fetch surfaces `LionDen blocked SDK network fetch to host "<host>". Allowed hosts: <list>. Extend sdk.egress.networkHosts or change sdk.egress.violation.` An unknown parameter host surfaces `LionDen does not recognize SDK parameter host "<host>". Known hosts: <list>. This may indicate a stale LionDen allowlist; please report.`

**Parameter downloads as a performance / cache concern.** See § SDK Objects for how the filesystem key cache covers credits-key downloads. For hermetic / offline operation, pre-warm the filesystem cache and then enforce no-network at the container / CI / firewall level — LionDen does not provide an in-process offline mode for parameter egress.

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
- `initConsensusHeights()` calls `sdk.getOrInitConsensusVersionTestHeights()` (no arguments) to prime the SDK's internal consensus version state. The SDK auto-derives the full set of test heights for its snarkVM baseline — on `@provablehq/sdk@^0.11.3` (snarkVM 4.8.1) that set ends at **V17** — so this is count-agnostic and independent of any Leo `--consensus-heights` flag (which Leo 4.3+ no longer accepts). It is required for devnode transaction builders and is non-fatal if the method is absent in older SDK versions. Devnode `prove: true` deploy/upgrade skips `checkDevnodeSdkSupport()` because it does not call the `buildDevnode*` methods, but still initializes consensus heights.

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
