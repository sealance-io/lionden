# LionDen Feature Status

**Last verified:** 2026-06-05

A snapshot of what currently works in LionDen, what's still missing for a 1.0, and what's deferred past V1. This doc is anchored to **shipped behavior** in the codebase, the working examples under `examples/`, and the bug-hunt probes that have been run against the deploy/upgrade subsystem during development.

For day-to-day usage, see [`usage.md`](usage.md). For design intent, see [`vision-and-roadmap.md`](vision-and-roadmap.md). For deeper detail on any subsystem, see the focused doc linked from this page.

> **How to use this doc:** treat it as the operational picture at a point in time, not a roadmap. Before relying on a specific claim, re-verify with `git log -- packages/` and a glance at the cited code path — features can land or shift between snapshots.

---

## 1. Shipped Features

Grouped by subsystem. Every row cites a code path. Subsystem-level deep dives live in [`docs/architecture.md`](architecture.md), [`docs/compiler.md`](compiler.md), [`docs/network.md`](network.md), [`docs/deployment.md`](deployment.md), and [`docs/testing.md`](testing.md).

### Config + CLI

| Feature | Evidence |
| --- | --- |
| Declarative plugin registration via `defineConfig({ plugins })` | `packages/config/src/index.ts`, `packages/core/src/plugin-loader.ts` |
| Four-stage config lifecycle (`extendUserConfig` → `validateUserConfig` → `resolveConfig` → `validateResolvedConfig`) | `packages/core/src/config-resolution.ts` |
| `configVariable("ENV_NAME")` with eager resolution (resolved for every network at load time, not lazily for the active one) | `packages/config/src/index.ts` |
| Hook categories: `config`, `compilation`, `network`, `testing`, `deployment` | `packages/core/src/types.ts` |
| Task builder API with `addOption`/`addFlag`/`addPositionalArgument`/`setAction`/`overrideTask`/`runSuper` | `packages/core/src/task-builder.ts` |
| CLI tasks registered today: `compile`, `clean`, `node`, `run`, `deploy`, `upgrade`, `export`, `recipe`, `test` | `packages/plugin-*/src/index.ts` |
| Global CLI options: `--config`, `--network`, `--prove`, `--verbose`, `--help`/`-h`, `--version`/`-v`; `--network <name>` selects a named `config.networks` entry, not an Aleo chain id | `packages/cli/src/task-dispatch.ts`, `packages/cli/src/index.ts` |
| Final task-aware CLI validation rejects unknown tasks, unknown named arguments, bare arguments before the resolved task, and after-task bare arguments that the task's positional schema cannot consume | `packages/cli/src/task-dispatch.ts`, `packages/cli/src/index.ts` |
| Config discovery walks up from cwd to find `lionden.config.{ts,js,mjs}` | `packages/cli/src/config-discovery.ts` |
| TypeScript config files loaded via `tsx`-import path | `packages/cli/src/bin.ts` |

### Compilation + Typechain

| Feature | Evidence |
| --- | --- |
| Source-first project layout — no manual `program.json` | `packages/leo-compiler/src/source-discovery.ts` |
| Discovers `main.leo` (program) and `lib.leo` (library) roots; preserves nested helpers in the source tree | same |
| Package materialization under `artifacts/.build/<id>/` before invoking `leo build` | `packages/leo-compiler/src/package-materializer.ts` |
| Dependency graph: local programs/libraries + network deps with topological order | `packages/leo-compiler/src/dependency-resolver.ts` |
| Network dependency fetching via `GET /{network}/program/{id}` with local cache under `artifacts/.cache` | `packages/leo-compiler/src/compiler.ts` (`defaultFetchNetworkDep`) |
| Content-hash compile cache, bypassed with `--force` | `packages/leo-compiler/src/compiler.ts` |
| ABI parsing into a normalized internal representation; bridges v4 and v3.5 ABI shapes | `packages/leo-compiler/src/abi-parser.ts` |
| TypeScript binding generation per program: `BaseContract.ts`, `<Name>.ts`, barrel `index.ts` | `packages/leo-compiler/src/codegen/typescript-generator.ts` |
| Generated transition methods: `.locally`, `.failsLocally`, `.captureLocalFailure`, `.submitted`, `.settled`, `.accepted`, `.rejected` | same |
| Mapping accessors: `mappings.<name>.{ contains, get, getOrUse, tryGet }` mirroring Leo's read ops (`get` throws `MappingKeyNotFoundError` when unset; `tryGet` returns `null`) | same |
| Record helpers: `serialize<Name>`, `deserialize<Name>`, `decrypt<Name>` | `packages/leo-compiler/src/codegen/` |
| Encrypted output types: `EncryptedRecord<T>.decrypt(key)`, `EncryptedValue<T>.decrypt(key)` | `packages/testing/...` + base contract code |
| Id-only record output handles: `IdOnlyDynamicRecordHandle` (Leo v4 `dyn record`) and `IdOnlyExternalRecordHandle<T>` (cross-program `Record` outputs) — both carry `id` + `transitions` callgraph for inspection; V15-compliant dynamic-record programs must materialize a concrete sibling output for spendable recovery (see [`research/dynamic-records-v15.md`](research/dynamic-records-v15.md)) | `packages/leo-compiler/src/codegen/contract-wrapper.ts` |
| Matcher-based record output API: direct ciphertext records can use `EncryptedRecord<T>.match(helper.output).decrypt(key)` for a uniform style with a program/recordName identity guard; id-only dynamic/external handles require a bound matcher via `helper.output.from(transition, idx)` or `.at(transitionIndex, idx)` before `.decrypt(key)`. `.match` is a pure builder; all validation + resolution + decryption is deferred to `CapturedRecord.decrypt(key)` | `packages/leo-compiler/src/codegen/contract-wrapper.ts` (`RecordOutputMatcher`, `CapturedRecord`, `createRecordOutputMatcher`, `BaseContract.resolveAndDecryptIdOnly`) |
| Leo primitive helpers: `Leo.address/.field/.group/.scalar/.identifier/.dynamicRecord` | base contract template |
| `codegen.dynamicRecords` config: per-program helpers that double as input converters (`asGoldToken(token)`) and output matchers (`asGoldToken.output.from(...)` / `.at(...)`). Imported external records emit a sibling `<ExternalRecord>.output` matcher value binding alongside the type alias; unresolved external records fall through to the public `createRecordOutputMatcher` factory at the call site | `packages/leo-compiler/src/codegen/contract-wrapper.ts`, `packages/leo-compiler/src/codegen/typescript-generator.ts` |
| `withSigner(signer)` chained API + per-call `options.signer` | base contract template |
| `compile` flags: `--force`, `--no-typechain`, `--program` | `packages/plugin-leo/src/index.ts` |
| `clean` task removes `artifacts/` and `typechain/` (preserves `deployments/`) | `packages/plugin-leo/src/index.ts` |

### Network + Devnode + Scripts

| Feature | Evidence |
| --- | --- |
| Two network variants: `devnode` (managed) and `http` (external) | `packages/config/src/types.ts` |
| Managed devnode lifecycle: spawn `leo devnode start`, health-poll REST, graceful shutdown | `packages/network/src/devnode-manager.ts` |
| Managed devnodes are testnet-like local chains; Leo devnode does not provide a reliable mainnet/canary/devnet simulation despite the retained `network` config field | `packages/network/src/devnode-manager.ts`, `docs/network.md` |
| `NetworkManager` resolves named accounts per network, caches per-network state, transactional `connect()` | `packages/network/src/network-manager.ts` |
| SDK adapter loads `@provablehq/sdk` dynamically; once-per-process WASM init; runtime checks for devnode builder methods | `packages/network/src/sdk-adapter.ts` |
| Devnode fast-path: `buildDevnodeDeploymentTransaction`/`buildDevnodeExecutionTransaction`/`buildDevnodeUpgradeTransaction` skip proofs unless `prove` is requested | `packages/network/src/connection.ts`, `packages/plugin-deploy/src/deploy-task.ts`, `packages/plugin-deploy/src/upgrade-task.ts` |
| HTTP path: `pm.deploy()`, `pm.execute()`, `pm.buildUpgradeTransaction()` + broadcast | same |
| Transaction confirmation polling: `GET /{network}/transaction/confirmed/{txId}`, block-height resolution via `GET /{network}/find/blockHash/{txId}` + `GET /{network}/block/{blockHash}` | same |
| Mapping reads: `connection.getMappingValue(programId, mapping, key)` | same |
| Balance and block-height helpers on `AleoConnection` | same |
| Low-level `connection.execute()` is fire-and-forget by default (broadcasts, returns `{ outputs: [], txId }`); awaited outputs available via `{ awaitConfirmation: true }` or the standalone `connection.getTransitionOutputs(txId, programId, transitionName)` helper. Rejected → `TransitionRejectedError`; 0/>1 transition matches → `TransitionSelectionError` (see [`network.md` § `execute()` and transition outputs](network.md#execute-and-transition-outputs)) | `packages/network/src/connection.ts`, `packages/network/src/transition-selector.ts` |
| Deployed program source fetch via `getProgramSource()` | same |
| `node` task: `--port` (default 3030), `--manual-blocks`, | `packages/plugin-network/src/index.ts` |
| `run` task: positional script path; imports the script and calls `default` or `main`; config network selection comes from global `--network` / `defaultNetwork` | same |
| `--consensus-heights` opt-in field for devnode (required for v3.5 constructor programs) | `packages/network/src/devnode-manager.ts`, config types |
| SDK egress policy (network-host scope): per-connection guarded `transport` on `AleoNetworkClient` and per-signer clones. Default `allowedNetworkHosts = { connection endpoint }` with `violation: "block"`; users extend via `sdk.egress.networkHosts` (telemetry, sidecars) and switch to `violation: "warn"` for rollout / debugging. Installing any transport flips `hasCustomTransport=true`, forcing state queries through `CallbackQuery` instead of WASM's `https://api.provable.com/v2`-baked SnapshotQuery — the load-bearing leak closure for the execute / prove path. A second WASM entry point, eager key synthesis (`synthesizeKeyPair`), takes no query parameter and is closed by skipping eager synthesis on every filesystem key-cache miss, deferring to lazy `pm.execute` synthesis through the `CallbackQuery`; sidecar/runtime cache hits are still injected. Parameter downloads (credits keys, SRS) use an internal known-host list; not user-configurable. See [`network.md` § Egress Policy](network.md#egress-policy) | `packages/network/src/sdk-adapter.ts` (`makeNetworkTransport`, `makeParameterTransport`, `SdkEgressPolicy`), `packages/network/src/network-manager.ts` (`resolveEgressPolicy`), `packages/network/src/connection.ts` (`getPersistentExecutionOptions`), `packages/core/src/config-resolution.ts` (`resolveSdkEgressConfig`) |

### Deploy + Upgrade + Export + Recipes

| Feature | Evidence |
| --- | --- |
| `deploy` task: compile → preflight → broadcast → record state → fire hook → optional export | `packages/plugin-deploy/src/deploy-task.ts` |
| Deploy flags/options: `--program`, `--priority-fee`, `--skip-confirm`, `--no-compile`, `--preflight`, `--dry-run` (devnode), `--no-skip-deployed`, `--export`; config network selection comes from global `--network` / `defaultNetwork` | `packages/plugin-deploy/src/index.ts` |
| `--prove` framework built-in global: `lionden --prove deploy`/`upgrade`/`recipe`/`test` (or a truthy `LIONDEN_PROVE`) forces standard/proven builders on devnode; `--prove=false` reliably disables it; `test` honours ambient `LIONDEN_PROVE` and prints a notice when the env (not a flag) is the source; per-call escape hatches on testing `ctx.deploy`/`ctx.execute` and recipe `deploy`/`execute` | `packages/core/src/arg-names.ts` (reserved name), `packages/cli/src/{task-dispatch,index}.ts` (parse + seed), `deploy-task.ts`/`upgrade-task.ts`/`recipe-task.ts` (`resolveProveOption`), `plugin-test/src/index.ts` (`test`) |
| Constructor parser recognises `@noupgrade`, `@admin(address=...)`, `@checksum(...)`, `@custom(...)` (also accepts optional `async constructor` for v3.5) | `packages/plugin-deploy/src/constructor-parser.ts` |
| Deploy preflight: on-chain status, HTTP fee estimation, HTTP balance check, imported program availability | `packages/plugin-deploy/src/preflight.ts` |
| Multi-program topological deploy order; targeted `--program` pulls transitive local deps | `packages/plugin-deploy/src/deploy-task.ts` |
| Deployment state on disk: `complete` / `degraded` / `recovered` records, per-network ABI snapshots, append-only history, pending markers, atomic temp+rename writes | `packages/plugin-deploy/src/deployment-manager.ts` |
| Ephemeral mode: devnode is in-memory by default; HTTP is disk-backed by default; per-network and global overrides | same |
| Pending marker recovery on next run (non-ephemeral networks) | same |
| `upgrade` task: ABI compat check, constructor immutability, edition continuity | `packages/plugin-deploy/src/upgrade-task.ts` + `abi-compat.ts` |
| `export` task: per-network bundle to `deployments/_exports/<network>.json` or `--out <path>`; writes even in ephemeral mode | `packages/plugin-deploy/src/index.ts` |
| `deploy.autoExport` hook after each deploy/upgrade | `packages/plugin-deploy/src/deployment-manager.ts` |
| Hooks: `deployment.programDeployed`, `deployment.programUpgraded` | `packages/core/src/types.ts` |
| `recipe` task: `--file`, `--export`, `--no-compile`; passes typed `DeploymentContext` (named accounts, deploy, execute, lre, accounts); config network selection comes from global `--network` / `defaultNetwork` | `packages/plugin-deploy/src/recipe-task.ts` |

### Testing

| Feature | Evidence |
| --- | --- |
| `setup()` returns `TestContext { lre, accounts, namedAccounts, named, connection, network, deploy, execute, raw.execute, advanceBlocks, teardown }` | `packages/testing/src/test-context.ts` |
| Auto devnode lifecycle gated by `config.testing.autoStartDevnode` (default true) | `packages/testing/src/devnode-lifecycle.ts` |
| `loadFixture(fn)` / `clearFixtures()` caches state across same-file tests | `packages/testing/src/fixtures.ts` |
| `TestContext` structurally satisfies `DeploymentContext`, so recipes call directly from fixtures | `packages/testing/src/test-context.ts` |
| Named account DSL: `ctx.named.signer(role)`, `ctx.named.address(role)`, `ctx.named.require({...})` | same + `packages/config/` |
| Assertions exported: `assertMappingValue`, `assertMappingEmpty`, `assertTransactionConfirmed`, `assertTransactionRejected`, `assertBalanceAtLeast`, `assertBalance`, `assertBlockHeightAtLeast` | `packages/testing/src/index.ts` line 24-33, `packages/testing/src/assertions.ts` |
| Devnode account utilities: `DEVNODE_ACCOUNTS`, `getDefaultAccount`, `getAccount`, `getAddresses`, `getAccountByAddress` | `packages/testing/src/index.ts` line 36-42 |
| Typed broadcast results: `AcceptedTransition<T>` carries decoded `outputs` parsed from the confirmed transaction (records → `EncryptedRecord<T>`, private plaintext → `EncryptedValue<T>`, public plaintext → decoded eagerly) | base contract `expectAcceptedTyped` |
| `ctx.raw.execute(programId, transitionName, args[])` escape hatch for post-upgrade transitions and dynamic ABI calls. Awaits confirmation and returns parsed `outputs` (and `rawOutputs` for id-only dynamic-record entries) by default; reentrant flows opt out via `{ awaitConfirmation: false }` + `ctx.connection.waitForConfirmation(txId)` | `packages/testing/src/test-context.ts` |
| `test` task: `--grep`, `--timeout`, `--no-compile`, `--parallel`, `--coverage` (proving is the built-in global `--prove` / `LIONDEN_PROVE`, see the `--prove` row above) | `packages/plugin-test/src/index.ts` |
| `test` task opt-in coverage: `--coverage` configures V8 coverage for package implementation source and keeps smoke coverage reporting-only through blob merge reports | `packages/plugin-test/src/index.ts`, `packages/plugin-test/src/test-runner.ts`, `scripts/run-smoke-examples.mjs` |
| Vitest integration sets `LIONDEN_PROJECT_ROOT`, scopes discovery to `test/**/*.test.ts`, returns summarized counts | `packages/plugin-test/src/test-runner.ts` |
| Vitest `agent` reporter usage convention (`npm run test:agent`) for low-noise agent runs | repo root `package.json` |

### Scaffolder

| Feature | Evidence |
| --- | --- |
| `create-lionden` interactive scaffolder; flags `--template`/`-t`, positional project name | `packages/create-lionden/src/index.ts` |
| Templates registered today: `hello-world`, `token` | `packages/create-lionden/src/templates.ts` |
| Emits `package.json`, `tsconfig.json`, `.gitignore`, `lionden.config.ts`, `programs/`, `scripts/deploy.ts`, `test/<name>.test.ts` | same |

### Leo Version Compatibility

| Feature | Evidence |
| --- | --- |
| Leo v4.2.x default; single-program / per-unit build layouts normalized to LionDen artifacts | [`leo-version-compatibility.md`](leo-version-compatibility.md), `packages/leo-compiler/src/compiler.ts` |
| Leo v4.0.x supported as an explicit compatibility line | [`leo-version-compatibility.md`](leo-version-compatibility.md) |
| Leo v3.5.x supported for deployable `main.leo` programs (no libraries) | same |
| `leoBinary` config (with `~/` expansion) to target a specific Leo install | `packages/config/src/types.ts` |
| `--disable-update-check` always passed to managed Leo CLI invocations | `packages/leo-compiler/src/`, `packages/network/src/devnode-manager.ts` |
| `consensusHeights` opt-in field on devnode networks (required for v3.5 constructor programs) | `packages/network/src/devnode-manager.ts` |
| ABI parser normalises `transitions`/`functions`, `is_async`/`is_final`, `Future`/`Final` between versions, and preserves Leo 4.1 `views`, `implements`, and non-empty `const_parameters` | `packages/leo-compiler/src/abi-parser.ts` |

---

## 2. Verified-In-Practice Matrix

The bullets below answer "what features have we actually exercised end-to-end, not just shipped?" Probes and examples are the two evidence sources.

### Bug-hunt probes (devnode only)

Five disposable agent-driven probes have been run against the deploy/upgrade subsystem to validate the scenarios below. The probes themselves live outside this repo; what they covered is summarized here.

| Probe | Validates |
| --- | --- |
| 1 | Single-program `@admin` deploy + confirmation + complete record + ABI snapshot + history entry + auto-export + post-deploy execution |
| 2 | Skip-deployed with existing complete state; missing local state → degraded record; `--no-skip-deployed` hard-error |
| 3 | Multi-program topological deploy (`base_math` → `rate_calc` → `loan_mgmt`); targeted deploy pulls transitive deps; cross-program execution |
| 4 | ABI-additive `@admin` upgrade; history append; mapping survives upgrade; ABI-breaking removal rejected via `UpgradeCompatibilityError` |
| 5 | Devnode-restart staleness, redeploy after restart, pending deploy recovery (found + missing marker cleanup) |

### Top-level examples

| Example | Features exercised |
| --- | --- |
| `examples/hello-world` | Pure transitions (`u32` add/multiply), `@noupgrade`, `loadFixture` + `setup`, `.locally()` |
| `examples/token` | Public + private transitions, mappings, records, named accounts (`signer` + `address`), `.accepted()`, `.withSigner()`, encrypted record decrypt, `advanceBlocks`, recipe pattern |
| `examples/multi-program` | Cross-program calls (`treasury.aleo::deposit`), `lib.leo` library import (compile-only), topological deploy, mapping getters |
| `examples/nft-registry` | Structs nested in records (`NftMetadata` in `Nft`), pure transitions returning tuples, mapping getters with type coercion |
| `examples/upgradeable-counter` | `@admin` constructor, full upgrade flow via `lre.tasks.run("upgrade", ...)`, `ctx.raw.execute()` for post-upgrade ABI, `assertMappingValue`, `assertBalanceAtLeast`, `assertBlockHeightAtLeast` |
| `examples/async-escrow` | Finalize-only transitions, mapping state mutation, `.failsLocally()` (off-chain assert), `.rejected()` (on-chain finalize failure) |

### `examples/aleo-ports/` — 22 compatibility ports

Confirmed at this snapshot: `admin`, `auction`, `basic_bank`, `battleship`, `bubblesort`, `dynamic_dispatch`, `dynamic_records`, `example_with_test`, `fibonacci`, `groups`, `helloworld`, `interest`, `lottery`, `message`, `noupgrade`, `simple_token`, `tictactoe`, `timelock`, `token`, `twoadicity`, `upgrades-vote`, `vote`. Notably `dynamic_dispatch` exercises Leo v4 interface dispatch via `Leo.identifier(...)` and declares its runtime dispatch targets in `execution.imports["governance.aleo"]` rather than as static `import` statements (see [`network.md` § Runtime Imports For Dynamic Dispatch](network.md#runtime-imports-for-dynamic-dispatch)); `dynamic_records` combines runtime dispatch with Leo v4 `dyn record` inputs and outputs, generated `codegen.dynamicRecords` helpers (input + `.output` matcher), wrapper instance imports, per-call imports, V15-compliant concrete-record consumes with `(Token, dyn record)` transfer materialization and a pure-read `balance_of(token: dyn record) -> u64` exercised only on internally produced records (see [`research/dynamic-records-v15.md`](research/dynamic-records-v15.md)), and the matcher-based output API including `demo_double_transfer` for `.from(..., { match: n })` ambiguity disambiguation, a negative identity-guard case on the encrypted-record arm, and a negative V15 record-existence case asserting a root `balance_of` is rejected; `noupgrade` exercises rejected `@noupgrade` upgrade; `timelock` exercises a positive `@custom` upgrade after block advancement; `upgrades-vote` deploys `@checksum` syntax but does not exercise the full voting/checksum authorization flow.

---

## 3. Gaps vs. Shipped Specs

The features below are described or implied by LionDen's design intent (see [`vision-and-roadmap.md`](vision-and-roadmap.md)) and the shipped subsystem docs but are either incomplete, untested, or carry a known TODO. Grouped by category.

### Integration gaps (code exists, no end-to-end coverage)

- **HTTP / testnet deploy path**: `pm.deploy()`, HTTP fee estimation, HTTP balance check, HTTP confirmation polling, API key handling — all implemented, none exercised by a probe against a real endpoint.
- **`--preflight` mode**: validation-only path implemented; no probe asserts the structured preflight output.
- **`--dry-run`**: devnode-only build-without-broadcast implemented; HTTP dry-run not implemented; neither probed.
- **`--skip-confirm` semantics**: flag implemented; deploy-state recording with `blockHeight: 0` (and similar partial-confirmation states) not probed.
- **Nonzero `priorityFee` / `privateFee`**: flags wired through; no probe exercises actual fee arithmetic.
- **Inter-deployment delay** (`deploy.interDeploymentDelay`, HTTP-only): default `12_000` ms set, never exercised end-to-end.
- **Standalone `lionden export --out ...`**: auto-export proven by probe 1; explicit CLI path not probed.

### Recovery and failure-path gaps

- **Pending *upgrade* recovery**: probe 5 covers pending `action: "deploy"`; the `previousEdition`-bearing pending-upgrade variant is not probed.
- **Rejected broadcast / confirmation**: no probe exercises a real rejected deploy or upgrade transaction (Aleo converts rejected executes to fee-only on inclusion — the deploy/upgrade equivalents aren't exercised here).
- **Upgrade from degraded/recovered records**: probe 5 creates a recovered record but never attempts an upgrade from it; degraded-record upgrade behavior is not exercised.
- **Stale ABI snapshot after degraded overwrite**: covered by a unit regression, but not by a real devnode probe.
- **ABI snapshot fallback to artifact**: probe 4 always has a snapshot; the missing-snapshot fallback to `artifacts/<programId>/abi.json` is not exercised.

### Compatibility gaps

- **Multiple networks**: only `devnode` is exercised. No probe simultaneously targets `devnode` + `testnet`/`mainnet`.
- **Mainnet target**: untested end-to-end.
- **Libraries in deploy context**: multi-program probes cover program imports, not `lib.leo` materialisation effects on deploy order.

### Performance / DX gaps

- **Proof-key disk caching**: shipped and enabled by default for compile-time sidecar refs, runtime cache reads, and every entry in `credits.aleo`'s `CREDITS_PROGRAM_KEYS` (fee, inclusion, join, split, bond_*, unbond_*, claim_unbond_public, transfer_*, set_validator_state, bond_validator) unless projects opt out with `sdk.keyCache.storage = "memory"`. Runtime user-program execution-key cache is currently read-only: current Leo v4 sidecars do not emit function key refs, and LionDen no longer writes execution keys on cache misses. Misses synthesize lazily through `pm.execute` and are not persisted on that call. Persistence is a performance layer; hermeticity is enforced separately by the egress policy. See [`research/key-caching.md`](research/key-caching.md) and [`network.md` § SDK Objects](network.md#sdk-objects).
- **Compile-time proving-key pre-warm**: deferred. Sidecar/runtime cache hits are reused, but runtime transition cache misses defer to lazy SDK synthesis through `CallbackQuery`. A compile-time pre-warm is blocked on an upstream SDK API change (real inputs required for `synthesizeKeyPair`). See [`research/key-caching.md`](research/key-caching.md).
- **Block-advancement throughput**: ~1s per block on devnode (Insight 18 in the same doc). Block-height-gated tests with thresholds > ~30 risk timeouts.

---

## 4. Recommended V1 Checklist (Proposal)

This is a **proposed** cut for a 1.0 release, not a ratified decision. It draws from §3 and prioritizes items that materially affect a user's ability to ship a program to a real network.

| # | Item | Status | Why it matters for V1 |
| --- | --- | --- | --- |
| 1 | Plugin model, config lifecycle, CLI, hooks | ✅ Done | Foundation; every other feature depends on it |
| 2 | Compile pipeline + typechain + cache | ✅ Done | The core developer-loop primitive |
| 3 | `node` + `run` + devnode lifecycle | ✅ Done | Local development surface |
| 4 | `deploy` / `upgrade` / `export` / `recipe` with `@noupgrade` + `@admin` on devnode (probes 1-5) | ✅ Done | Devnode happy-path coverage |
| 5 | Testing harness (`setup`, fixtures, assertions, typed `outputs`) | ✅ Done | The de-facto way users will validate programs |
| 6 | At least one passing HTTP-network end-to-end smoke (deploy + execute + export against a real testnet endpoint) | 🟡 Open | Without this, "deploy to mainnet/testnet" is unverified — biggest production-readiness gap |
| 7 | Release-gate constructor probes for remaining risks: real `@checksum` authorization, `@custom` negative path, and `@noupgrade` rejection in the five-probe suite | 🟡 Open | Constructor types are core to ARC-0006 upgradability; aleo-ports cover some behavior, but the release probe set still misses security-relevant paths |
| 8 | Negative-path probes for upgrade: wrong admin signer, constructor mutation between editions | 🟡 Open | Upgrade safety is a security boundary; happy-path-only is dangerous |
| 9 | Resolve the `connection.execute()` outputs TODO — low-level `connection.execute()` is fire-and-forget by default; user-facing helpers (`ctx.execute`, `ctx.raw.execute`, recipe `execute`) auto-await and return parsed outputs; `connection.getTransitionOutputs(...)` + `awaitConfirmation: true` are the network-layer output paths | ✅ Done | `packages/network/src/connection.ts` (execute + new `getTransitionOutputs`), `packages/network/src/transition-selector.ts`, `packages/testing/src/test-context.ts`, `packages/plugin-deploy/src/recipe-task.ts` |
| 10 | Pending-upgrade recovery probe (`action: "upgrade"` with `previousEdition`) | 🟡 Open | Upgrade-mid-crash recovery is the only state-recovery code path with no probe |
| 11 | Curated type bindings (or equivalent typed helper) for `credits.aleo` and the most common network-imported programs | 🟡 Open | Today users call imported network programs through `ctx.raw.execute(...)` — no type safety. A curated binding for at least `credits.aleo` closes the most-cited DX gap until the generalized SDK ABI-extraction path (see §5) is available |
| 12 | Proof-key disk caching (runtime + sidecar + named credits keys) | ✅ Done | Filesystem-backed cache lands the predictable-heavyweight-flow win for named credits keys and any available sidecar/runtime execution-key hits; current Leo v4 user-program execution misses are not persisted and stay on the guarded lazy prove path. Compile-time pre-warm remains deferred; see [`research/key-caching.md`](research/key-caching.md) |

Items 1-5 are shipped today. Items 9 and 12 are also shipped (per the entries above and the §3 update). Items 6-8, 10, and 11 are the remaining proposed open-set for 1.0: integration coverage, constructor / upgrade negative-path probes, and the curated `credits.aleo` bindings.

If only one of the open items ships, item 6 (HTTP smoke) is the most operationally important.

---

## 5. Post-V1 / Out-Of-Scope

Features explicitly deferred by the specs, or surfaced by the doko-js comparison (§6) but not on the V1 critical path.

- **Custom test runners** beyond Vitest. Spec validates `framework: "vitest"` today.
- **Mainnet probe automation**. Anything touching mainnet should be a deliberate, gated operation; full automation isn't urgent.
- **Frontend / web bindings**. The vision doc hints at this; not in any current phase.
- **Library effects on multi-program deploy ordering**. Libraries are compile-only today; deploy ordering treats them as not-deployable.
- **Generalized typechain generation for any deployed `.aleo` (network-fetched or user-supplied bytecode)**. Blocked on confirming the SDK ABI-generation surface in the version LionDen consumes, so we can derive an ABI from compiled Aleo bytecode rather than requiring Leo source. Tracking: [ProvableHQ/leo#29350](https://github.com/ProvableHQ/leo/pull/29350), merged upstream on 2026-04-30. Once available in LionDen's SDK dependency, the compile pipeline can extend codegen to network-fetched programs and emit typed wrappers automatically — superseding the per-program curated bindings introduced for V1 (checklist item 11).
- **Expanded testing utilities** — convenience helpers beyond what `@lionden/testing` ships today (`setup`, `loadFixture`, the `assertMapping*` / `assertBalance*` / `assertBlockHeightAtLeast` / `assertTransaction*` assertions, devnode accounts). Candidates worth considering: Vitest custom matchers (`expect(tx).toBeAccepted()`, `expect(mapping).toHaveValue(...)`, decryption-aware matchers), synthetic/parallel address generators for tests that need many recipients, named-account-aware fixture helpers. None of these are blocking — they're DX polish.
- **Deployment verification on explorers.** EVM-style bytecode-to-source verification is out of scope for v1. Aleo stores and exposes the deployed Aleo Instructions program (the compilation target, not original Leo source), so users can inspect the canonical deployed program text via `getProgram()`. LionDen does not attempt to verify or publish original Leo source, compiler metadata, project layout, or source maps in v1.

### Open question: devnode lifecycle control granularity

Today `@lionden/testing`'s `setup()` is gated by `config.testing.autoStartDevnode` (default `true`). Devnode lifecycle is effectively coupled to whoever calls `setup()` first in a test process, with teardown driven by `ctx.teardown()` and fixture caching via `loadFixture`. The practical granularity is "per process" — Vitest typically runs each test file in its own worker, so the effective unit is "per file".

Worth investigating before V1 / for post-V1 DX:

- **Granularity options users might want**: per-process (today), per-suite (a fresh devnode for each `describe` block), per-test (fresh devnode for each `it`), shared across the whole run (one devnode for all files in a Vitest invocation).
- **External lifecycle via Vitest hooks**: can `lionden test` expose a hook (or can the CLI accept a `--no-managed-devnode` flag) so users can manage devnode in a Vitest `globalSetup` / `globalTeardown` file? This is the pattern doko-js consumers (and the Sealance fork in `compliant-transfer-aleo`) use via Testcontainers in `vitest.global-setup.ts`. LionDen doesn't currently document a supported equivalent.
- **Cross-file state sharing**: with the current per-file devnode, deployments don't persist across test files (each gets a fresh devnode). Some test suites want shared on-chain state across files (sequential, ordered execution) — that's not a supported pattern today.

This is an open design question, not a known bug. Worth a design note before V1 to either document the supported pattern explicitly or expand the options.

---

## 6. Doko-js Parity (Reference)

LionDen and **doko-js** ([github.com/venture23-aleo/doko-js](https://github.com/venture23-aleo/doko-js)) solve overlapping problems for Aleo/Leo developers. The catalog below is for sanity-checking scope — it is not a feature-by-feature roadmap. Sources: an upstream doko-js checkout inspected for this comparison (HEAD `662be4f`, packages at `1.1.0`, README still naming Leo `v3.4.0` / SnarkOS `v4.4.0`) plus the real-world `compliant-transfer-aleo` project, which carries Sealance-specific patches and harness code.

### Where LionDen and doko-js are at parity

- **Leo compile + TypeScript binding generation** (class-per-program, typed transitions).
- **Mapping queries** (LionDen: `connection.getMappingValue()` + typechain `mappings.<name>.{contains,get,getOrUse,tryGet}`; doko-js: `zkGetMapping()`).
- **Private record decryption** (LionDen: `EncryptedRecord<T>.decrypt(key)`; doko-js: generated `decrypt<Name>()` helpers).
- **Multi-account testing** (LionDen: `DEVNODE_ACCOUNTS` + `namedAccounts`; doko-js: per-network `accounts` array + `getAccounts()`).
- **Multi-program / cross-program deploy** (both topologically order local dependencies).
- **JS/TS test workflows around generated wrappers** (LionDen ships Vitest-first testing; upstream doko-js templates use Jest; Sealance doko-js consumers use Vitest/Testcontainers around doko-generated wrappers).

### What LionDen has that doko-js does not (per inspected doko-js 1.1.0 checkout)

- **First-class `upgrade` task** with ABI compatibility checks, constructor immutability. Doko-js has no `upgrade` command at all — its `cli/src/scripts/deploy.ts` shells out to `leo deploy` and that's it; upgrades would be hand-rolled by the consumer.
- **Deployment state with `complete` / `degraded` / `recovered` record statuses**, ABI snapshots, append-only history, pending markers, atomic temp+rename writes.
- **Crash-recovery for pending deploys** via on-next-run reconciliation against on-chain state.
- **`--preflight` and `--dry-run` deploy modes**.
- **Recipe system** (`DeploymentContext` / `DeploymentRecipe`) with structural compatibility between CLI and test contexts.
- **Named accounts with eager `configVariable` resolution** mapping human roles (`deployer`, `admin`, `treasury`) to per-network values.
- **Source-first project layout** — no manual `program.json`.
- **Ephemeral vs disk-backed deployment state**, picked per network with overrides.

### What doko-js has that LionDen does not

- **Wide adoption in existing Aleo projects.** Doko-js is the toolchain a number of Aleo projects (e.g., `compliant-transfer-aleo`) already depend on, with patched/forked builds in the wild. It is not actively maintained upstream and tends to lag behind new Leo CLI releases, so "widely used" is the better framing here than "production-grade" — but as a practical matter, switching off doko-js is a real cost for those projects. LionDen is in active early development; this is an adoption-and-momentum gap, not a feature gap.
- **A battle-tested Leo v3.4-oriented compatibility lane.** Upstream doko-js still documents Leo `v3.4.0` as its baseline and has accumulated many fixes around that toolchain, generated wrappers, output parsing, record handling, and network execution. LionDen instead targets Leo v4 by default with scoped v3.5 deployable-program support.
- **Type bindings for "imported" network programs (e.g. `credits.aleo`).** Doko-js (and its consumer templates) provides typed wrappers for pre-deployed Aleo programs so user code can invoke them in a type-safe way. LionDen currently fetches network dependencies as compiled Aleo source for the compile pipeline (see `defaultFetchNetworkDep` in `packages/leo-compiler/src/compiler.ts`) but does **not** emit typechain bindings for them — calls into `credits.aleo` and friends go through `ctx.raw.execute(...)` or the imperative connection API today. Two follow-ups, tracked separately:
  - **V1 (open — see checklist item 11):** ship curated, first-party bindings (or a similarly ergonomic helper) for the most common network programs starting with `credits.aleo`, so users get a type-safe surface without waiting for upstream tooling.
  - **Post-V1:** generalized "generate bindings from any deployed `.aleo`" path, blocked on confirming `generate_abi_from_aleo` (or equivalent) in the `@provablehq/sdk` version LionDen consumes. Once available, LionDen can extend the existing typechain pipeline to consume network-fetched programs and emit wrappers automatically.

### Different approach (not necessarily a gap either direction)

- **Leo version baseline**: doko-js is a Leo v3.4.0-oriented toolchain with many compatibility fixes; LionDen targets v4 by default with scoped v3.5 deployable-program support.
- **Typed program-wrapper generation**: LionDen builds wrappers from the structured JSON ABI emitted by modern Leo (`build/abi.json`; introduced in the v3.5 line and normalized for v3.5/v4 differences). Doko-js predates that ABI contract and instead parses compiled `.aleo` output into its own reflection model before generating TypeScript.
- **Transaction building and broadcasting**: LionDen routes deploy/execute/upgrade through `@provablehq/sdk` APIs (`ProgramManager`, devnode transaction builders, broadcast helpers), using the TypeScript SDK facade backed by WASM internals. Doko-js shells out to the Leo CLI for execution/deploy flows, which keeps it close to CLI behavior but requires assembling command-line arguments and parsing process output/errors for transaction IDs, results, and failures.
- **Test execution mode**: doko-js exposes execution-mode toggles (`SnarkExecute`, `LeoExecute`, etc.) at contract instantiation time; LionDen splits this into method-level `.locally()` (off-chain) vs. `.accepted()`/`.settled()`/`.rejected()` (on-chain).
- **Default test runner**: upstream doko-js scaffolds Jest; LionDen's built-in test task is Vitest-first. Sealance doko-js consumers may use Vitest, but that comes from the consuming repo's harness rather than upstream doko-js.
- **Post-deploy initialization** (calling a user-defined transition like `initialize_admin(...)` after the program is on-chain, separate from Leo's mandatory program constructor): both frameworks treat this as a userland convention — call a regular transition. LionDen formalizes the multi-step pattern with `recipe` / `DeploymentRecipe` so the same sequence runs from CLI or from a test fixture; doko-js consumers write ad-hoc TypeScript scripts (e.g., `compliant-transfer-aleo/scripts/initializeProgram.ts`). Reasoning about the Leo program constructor itself is **not** a "different approach" — see "ARC-0006 constructor model" above; that's a feature-presence gap, not a stylistic difference.

---

## 7. Where To Learn More

- [`usage.md`](usage.md) — day-to-day usage walkthrough.
- [`vision-and-roadmap.md`](vision-and-roadmap.md) — product direction, design decisions, known challenges, roadmap shape.
- [`architecture.md`](architecture.md), [`compiler.md`](compiler.md), [`network.md`](network.md), [`deployment.md`](deployment.md), [`testing.md`](testing.md) — subsystem deep dives.
- [`project-layout.md`](project-layout.md) — package map and contributor entry points.
- [`leo-version-compatibility.md`](leo-version-compatibility.md) — v4 default, scoped v3.5 support.
- [`json-abi.md`](json-abi.md) — ABI schema and codegen type mapping.
- [`testing-strategy.md`](testing-strategy.md) — repo-wide test taxonomy and CI lanes.
- [`agent-bug-hunt-workflow.md`](agent-bug-hunt-workflow.md) — how the disposable bug-hunt probes referenced above are structured.

When code and any doc (including this one) disagree, trust the code.
