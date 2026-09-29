# Network

When to read this: use this file for network config types, connection management, devnode lifecycle, SDK integration, transaction confirmation, and script execution. For deploy, upgrade, export, and deployment state, use [`deployment.md`](deployment.md).

Sections: [network selection](#network-selection-and-the-worker-bridge) · [network manager and `execute()`](#network-manager) · [devnode lifecycle](#devnode-lifecycle) (backends, snapshots, `node` task, log mode) · [runtime imports](#runtime-imports-for-dynamic-dispatch) · [SDK integration](#provable-sdk-integration) (key cache, [egress](#egress-policy), transaction building, confirmation) · [scripts](#script-execution) · [config validation](#config-validation)

## Current Network Model

`packages/config/src/types.ts` defines two network config variants:

- `devnode`
- `http`

Resolved config stores them under `config.networks` and selects one through `config.defaultNetwork` unless the CLI or task overrides it. See [Network Selection And The Worker Bridge](#network-selection-and-the-worker-bridge) for how `--network` flows from the CLI into Vitest worker test contexts.

Current defaults include an implicit `devnode` network when the user does not configure any networks.

## Network Selection And The Worker Bridge

The active network is resolved in this order:

- **CLI `--network <name>`** is a built-in global. The CLI validates it against `config.networks`, mutates `config.defaultNetwork` for the in-process run, and seeds it into `globalOptions["network"]`. Every task except `test` reads the mutated `config.defaultNetwork` directly.
- **`test --network <name>`** additionally bridges the selection to Vitest worker processes via the `LIONDEN_NETWORK` env var (alongside `LIONDEN_PROJECT_ROOT`, `LIONDEN_CONFIG_PATH`, `LIONDEN_PROVE`, and — for an explicit `--deploy-backend` — `LIONDEN_DEPLOY_BACKEND`). It is set only when `--network` was supplied, so default runs leave it unset. Each worker's LRE (`@lionden/testing` `buildLre()`) retargets `config.defaultNetwork` to the bridged name — validated, with an unknown name throwing a clear error — so worker `setup()` contexts target the same network the CLI selected. A per-call `setup({ network })` still wins over the bridged default.
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
- proxy `execute()`, read-only view-function queries (`queryView()`), mapping reads, and storage reads to the active connection

`connect()` is transactional: if named-account resolution fails after a new connection is created, only the new connection is closed and the previous active connection and named accounts are preserved. Switching back to a previously-connected network restores named accounts from the per-network cache without re-resolving.

Connection creation currently maps:

- `devnode` to `http://<socketAddr>`
- `http` to the configured endpoint

`packages/network/src/connection.ts` provides `AleoConnection`, including REST/SDK-backed helpers for execution, view-function queries (`queryView`, `POST /{network}/program/{programId}/view/{viewName}`; see [`typechain.md`](typechain.md#view-functions)), mapping reads, balance checks, block height, transaction broadcasting, transaction confirmation, deployed program source fetching, and program edition reads (`getProgramEdition`).

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

The Leo CLI backend also behaves as a testnet devnode in practice — even where a non-`testnet` `network` is accepted, it does not turn the local chain into mainnet, canary, or devnet — so use an `http` network to target a real network. `consensusHeights`, and a non-`testnet` `network`, are forwarded to `leo devnode start` only on Leo **< 4.3**. On Leo **4.3+** (or an unparseable `leoVersion`), LionDen omits both flags, and config validation (for `provider: "leo"` or an omitted `provider`) rejects any `consensusHeights` and a non-`testnet` `network`; an omitted `network` defaults to `"testnet"` and passes (see [Config Validation](#config-validation)). For why — Leo 4.3 removed both flags, and its devnode auto-activates the latest consensus version — and for the Leo v3.5 constructor-program case that needs explicit heights, see [`leo-version-compatibility.md`](leo-version-compatibility.md#devnode-consensus-heights).

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

Runtime imports contribute to `importsHash` in the proving-key cache identity, so introducing a new dispatch target changes that identity: previously cached runtime keys for the dispatching program no longer match, and the next execute synthesizes keys lazily without LionDen persisting them (see [`research/key-caching.md`](research/key-caching.md#lookup-order)).

Runtime imports are **execution-time** dependencies only, not deploy-time deps. The compiler's static-import-based dependency resolver does not follow them, so a dispatch hub's strategy programs must be deployed explicitly (or pulled in via the normal `import` graph elsewhere). See `examples/aleo-ports/dynamic_dispatch` for config-level defaults and `examples/aleo-ports/dynamic_records` for wrapper instance imports plus per-call imports.

For renamed wrappers, config-level runtime imports are still keyed by the wrapper's effective runtime `programId`. `sourceProgramId` is compile/deploy provenance and is not used for execution-config lookup; if a renamed program should use the same runtime imports as its source program, declare those imports explicitly under the renamed runtime id.

### Id-only record outputs (`dyn record` and external `Record`)

The client-side API for these outputs (`IdOnlyDynamicRecordHandle`, `IdOnlyExternalRecordHandle<T>`, `.match(...)` / `.decrypt(key)`, record-output matchers, and `IdOnlyRecordResolutionError`) is documented in [`typechain.md` § Id-only record outputs](typechain.md#id-only-record-outputs-dyn-record-and-external-record).

## Provable SDK Integration

`packages/network/src/sdk-adapter.ts` is the single point of contact with `@provablehq/sdk`. It loads the SDK module dynamically on first use and initializes the WASM thread pool once per process. Other network and deploy code imports helpers from that module rather than touching the SDK directly — nothing reaches around it.

That remains true, with one path that opts out of the SDK altogether rather than bypassing the adapter: when `deploy.backend` is `"leo"`, deploy and upgrade transactions are built by a `leo deploy` / `leo upgrade` child process and never enter the SDK at all. Broadcast and confirmation still go through `NetworkConnection`, and execution is always SDK-backed. The practical consequence is that `sdk.egress` cannot be enforced for that build step — Leo issues its own HTTP requests from a separate process, outside `makeNetworkTransport` — so LionDen refuses the combination outright rather than dropping the policy silently. Likewise `sdk.keyCache` is inert there, since Leo caches under `~/.aleo`. See [`deploy-backends.md`](deploy-backends.md).

### SDK Objects

`createSdkObjects()` constructs the full SDK object set for a connection: `Account`, `AleoNetworkClient`, `AleoKeyProvider`, `NetworkRecordProvider`, and `ProgramManager`.

When a task supplies a custom signer key, `createSignerSdkObjects()` builds an isolated `Account`, `ProgramManager`, and `NetworkRecordProvider` for that signer while sharing the key provider with the default connection.

SDK proving-key caching defaults to a filesystem-backed key cache:

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
| `credits.aleo` named keys (`fee_public`, `fee_private`, `inclusion`, `join`, `split`, `bond_public`, `bond_validator`, `unbond_public`, `claim_unbond_public`, `set_validator_state`, `transfer_*`) | persisted under `lionden-credits/<wasmHash>/<network>/`; warmed into the SDK key provider on init, written back on first fetch |
| `credits.aleo/functionKeys(search)` for non-credits locators (arbitrary user program keys) | not persisted by LionDen; the SDK handles its own in-memory caching |
| Deploy / upgrade program keys | not persisted by LionDen v1 |
| Translation keys | not persisted by LionDen v1 |

This expansion is a **performance** improvement: it keeps repeated prove runs from re-fetching every credits.aleo proving key the SDK touches. Parameter-download hosts, the mirror retry, and offline operation are covered under [Egress Policy](#egress-policy) (**Scope**).

Runtime execution-key misses are synthesized lazily inside `pm.execute` and are not persisted by LionDen, so later processes synthesize again unless sidecar or runtime cache entries already exist. Covered `credits.aleo` keys are written back after the SDK's first fetch and reused by later processes. LionDen resolves program source and imports from local artifacts first, falling back to the connected network, and passes the resolved import graph to execution. For cache identity, the proven-execution and credits lookup order, and the paths LionDen deliberately leaves to the SDK, see [`research/key-caching.md`](research/key-caching.md#lookup-order).

### Egress Policy

LionDen installs a guarded `transport` on every `AleoNetworkClient` it constructs (standalone, `ProgramManager`-internal, per-signer copies). The transport restricts SDK chain-state and transaction-submission egress to an explicit per-connection allowlist, and — independently of egress filtering — flips the SDK's `hasCustomTransport` flag to `true`. That flag is load-bearing: with it set, the prove path routes `stateRoot` / `statePaths` / `latestHeight` lookups through a JS `CallbackQuery` whose host comes from the connection. Without it, WASM falls back to an internal SnapshotQuery bound to the WASM-baked `https://api.provable.com/v2` constant and leaks state queries to the public host.

This closes the leak on the **execute / prove** path (`pm.execute` → `buildExecutionTransaction`), where the SDK threads the `CallbackQuery` based on `hasCustomTransport`. It does **not** by itself cover the **eager key-synthesis** path: the WASM `synthesizeKeyPair` takes no query parameter, so it can bypass the transport entirely (the guard never sees it — it is a native WASM fetch, not a JS one). That second entry point is closed separately: LionDen never calls eager `synthesizeKeyPair` on a filesystem key-cache miss. Cache hits are still injected; misses defer to lazy `pm.execute` synthesis through the `CallbackQuery`. See [`research/key-caching.md` § Lookup order](research/key-caching.md#lookup-order) for the lookup order and `getPersistentExecutionOptions`.

**Scope.** The policy governs **network-host** fetches only — chain-state reads, transaction submission, anything `AleoNetworkClient` does. Parameter downloads (credits proving/verifying keys, KZG SRS) are governed by the SDK key cache (see [SDK Objects](#sdk-objects)) and an **internal** known-host list (`parameters.provable.com`, `s3.us-west-1.amazonaws.com`, `parameters.aleo.org`); they are not user-configurable. When a `parameters.provable.com` request throws or returns a non-OK response, LionDen retries the equivalent `s3.us-west-1.amazonaws.com/<network>.parameters/...` mirror before surfacing the primary failure. An unknown parameter host means LionDen's allowlist is stale relative to the installed SDK and surfaces as an actionable error. For hermetic / offline operation, pre-warm the filesystem key cache and enforce no-network at the container / CI / firewall level; LionDen has no in-process offline mode for parameter egress.

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
- `initConsensusHeights()` calls `sdk.getOrInitConsensusVersionTestHeights()` (no arguments) to prime the SDK's internal consensus version state. The SDK auto-derives the full set of test heights for its snarkVM baseline (see [`leo-version-compatibility.md`](leo-version-compatibility.md#consensus-v16-on-the-leo-43-devnode) for the consensus versions each Leo line and the locked SDK cover), so this is count-agnostic and independent of any Leo `--consensus-heights` flag (which Leo 4.3+ no longer accepts). It is required for devnode transaction builders and is non-fatal if the method is absent in older SDK versions. Devnode `prove: true` deploy/upgrade skips `checkDevnodeSdkSupport()` because it does not call the `buildDevnode*` methods, but still initializes consensus heights.

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
- a devnode `clearStorageOnStart` requires a `storagePath`
- a devnode with an explicit `provider: "standalone"` rejects a non-`testnet` `network` and any `consensusHeights`; an auto-detected standalone backend gets the same checks at start time instead (see [Backend selection](#backend-selection))
- otherwise (`provider: "leo"` or omitted), when `leoVersion` is 4.3 or later (or unparseable), a devnode rejects `consensusHeights` and a non-`testnet` `network`; an omitted `network` defaults to `"testnet"` and passes

Deploy-specific validation is documented in [`deployment.md`](deployment.md).

## Design Direction

For the broader network abstraction, devnode-first rationale, and SDK baseline, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the current network package and plugin source for the implementation contract that exists today.
