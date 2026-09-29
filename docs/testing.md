# Testing

When to read this: use this file for `@lionden/testing`, the `test` task, devnode lifecycle in tests, fixtures, and assertion helpers.

## Current Testing Model

LionDen uses Vitest rather than a custom test runner. The repo provides:

- `@lionden/testing` for programmatic test setup and helpers
- `@lionden/plugin-test` for the `test` CLI task

The intended pattern is:

1. create a test context with `setup()`
2. optionally deploy one or more programs
3. execute transitions through the network connection
4. use assertion helpers and fixtures
5. tear the context down after the suite

This testing approach is built around a devnode-first workflow, suite-level isolation, and ordinary Vitest lifecycle hooks rather than a custom LionDen-owned test framework.

## `setup()` And Test Context

`packages/testing/src/test-context.ts` defines the primary testing surface.

`setup()` currently:

- creates or reuses an LRE
- optionally starts a managed devnode — only when the target network is itself a devnode (a non-devnode/http target skips devnode auto-start entirely, including under `snapshotReset: true`, which then fails with a clear message)
- connects to the selected network
- exposes well-known devnode accounts when connected to devnode, otherwise an empty account list
- returns helpers for deploy, execute, advance blocks, and teardown

Target network precedence: `setup({ network })`, then an explicit `lionden test --network <name>` (bridged to workers; see [Vitest Integration](#vitest-integration)), then `config.defaultNetwork`.

The resulting `TestContext` includes:

- `lre`
- `accounts`
- `namedAccounts` — resolved named accounts for the active network (see [deployment.md § Named Accounts](deployment.md#named-accounts))
- `named` — required-role accessor for named accounts
- `connection`
- `network`
- `deploy()`
- `execute()`
- `raw.execute()` — explicit string-based escape hatch for dynamic ABI or post-upgrade transition calls
- `advanceBlocks()`
- `snapshot()` / `restore()` / `listSnapshots()` — snapshot-based fast reset (see below)
- `teardown()`

This is the interface used by the example tests in `examples/`.

Generated typechain wrappers are preferred when the ABI is known. Use `ctx.raw.execute(...)` only when the typed wrapper cannot describe the call, such as a transition introduced by an upgrade after the test process loaded the v1 typechain class. `ctx.execute(...)` remains available for compatibility with older tests.

`ctx.raw.execute(...)` accepts the same `options.imports?: readonly string[]` surface as the typed wrappers — useful when an escape-hatch call needs to load dynamic-dispatch targets (program ids or local `.aleo` paths) that the dispatching program doesn't `import` statically. See [`network.md` § Runtime Imports For Dynamic Dispatch](network.md#runtime-imports-for-dynamic-dispatch) for the full model.

`ctx.execute(...)` and `ctx.raw.execute(...)` await on-chain confirmation by default and return the matching transition's parsed `outputs` (plus `rawOutputs`, the faithful on-chain output shape including any `idOnly` dynamic-record entries, whenever the call awaited confirmation). Pass `{ awaitConfirmation: false }` to recover fire-and-forget semantics — useful when broadcasting many transitions in parallel, or as the escape hatch for reentrant / recursive flows (see [`typechain.md` § `rawOutputs` transition identity](typechain.md#rawoutputs-transition-identity)).

`deploy()` accepts a bare program name, a `.aleo` program id, or a generated wrapper with a `programId` property. It checks the deployment manager cache before invoking the `deploy` task. This avoids redeploying a program already deployed in the same session and returns the cached complete `{ programId, txId }` when available. If the deploy task skips all targets, `deploy()` checks the cache again and returns only complete records with a `txId`; degraded or recovered records still throw because they cannot identify the original deployment transaction. Pass `{ noSkipDeployed: true }` when a fixture must fail instead of reusing or skipping an existing deployment. `teardown()` invalidates the deployment cache for the connected network so the next test context revalidates state against the active network. The `network` property on `TestContext` exposes the connected network name. `TestContext` structurally satisfies `DeploymentContext` from `@lionden/plugin-deploy`, so deployment recipes can be called directly from test fixtures without any explicit type casting.

`namedAccounts` is populated from `lre.namedAccounts` after `connect()`. It holds `{}` when no `namedAccounts` field is present in the project config — existing tests continue to work unchanged. New tests should prefer `ctx.named.signer(...)`, `ctx.named.address(...)`, or `ctx.named.require(...)` for required named-account roles.

## Devnode Lifecycle In Tests

`packages/testing/src/devnode-lifecycle.ts` wraps `DevnodeManager` for test suites.

Current behavior:

- uses the settings of the *selected* devnode network when `setup()` passes one (so the started node's bind address, verbosity, genesis, and private key match the network the test connects to); otherwise derives defaults from the default-then-first configured devnode network
- starts a devnode unless the caller skips it or the target network is not a devnode
- verifies a manually supplied devnode is reachable up front when setup uses a devnode network but did not start one
- returns a managed handle with endpoint metadata
- tears it down during cleanup

`setup()` respects `config.testing.autoStartDevnode`.

Managed devnodes default to `logMode: "quiet-buffered"` — output is drained and ring-buffered (last 64 KiB per stream). Set `LIONDEN_DEVNODE_LOGS=inherit` to surface devnode logs to the test runner output without editing test code. See [`network.md`](network.md#devnode-log-mode) for the full log-mode contract and precedence rules.

The devnode backend is resolved per the [backend-selection rules](network.md#devnode-lifecycle): a configured `provider` is honored, otherwise the standalone `aleo-devnode` binary is auto-detected with a fallback to the bundled Leo devnode.

### Snapshot-based fast reset

`setup({ snapshotReset: true })` enables snapshot/restore for the auto-started devnode. It forces the standalone `aleo-devnode` backend (failing with a clear error if the binary is unavailable) and allocates a throwaway storage directory under the OS temp dir; `teardown()` removes it (including the sibling `*-snapshots/` directory the binary writes alongside it). `snapshotReset` requires an auto-started devnode — it cannot combine with `skipDevnode: true` or `autoStartDevnode: false`.

The context then exposes:

- `ctx.snapshot(name?)` — capture the current ledger; returns `{ name, height }`.
- `ctx.listSnapshots()` — list snapshot names.
- `ctx.restore(name)` — roll the chain back to a snapshot **and** invalidate the deployment session cache, so a subsequent `ctx.deploy()` re-validates against the restored chain instead of returning a stale cached deployment.

Typical pattern: snapshot once after a baseline deploy in `beforeAll`, then `restore` in `beforeEach` for fast per-test isolation.

```typescript
let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup({ snapshotReset: true });
  await ctx.deploy("my_program");
  await ctx.snapshot("baseline");
});
beforeEach(async () => {
  await ctx.restore("baseline");
});
afterAll(async () => {
  await ctx.teardown();
});
```

## Test Runner Task

`packages/plugin-test/src/index.ts` exposes the `test` task.

Current flow:

1. run `compile` unless `--no-compile` is set
2. dispatch testing suite setup hooks
3. run Vitest through `packages/plugin-test/src/test-runner.ts`
4. dispatch testing suite teardown hooks

Current task options:

- `[files...]`
- `--grep`
- `--timeout`
- `--no-compile`
- `--parallel`
- `--coverage`

The task also forwards the `--prove` and `--network` framework built-in globals and `@lionden/plugin-deploy`'s `--deploy-backend` global option to Vitest workers, alongside an explicit `--config` path (see [Vitest Integration](#vitest-integration)).

`--prove` is a framework **built-in global** (not a `test` task flag) — `lionden --prove test` and `lionden test --prove` both force proof generation. The `test` task also honours an ambient truthy `LIONDEN_PROVE` (consistent with `deploy`/`upgrade`), parsed permissively (`1`/`yes`/`on`/…); when the env — not a flag — is the source, the run prints `Proving enabled via LIONDEN_PROVE`. An explicit `--prove=false` reliably disables proving even when `LIONDEN_PROVE` is set. The resolved value is canonicalized into `LIONDEN_PROVE="true"` (or cleared) **before** suite-setup hooks run, so hooks and Vitest workers observe the same value. On managed devnode this makes `ctx.deploy()`/`ctx.execute()` and direct `upgrade` task calls use the standard ProgramManager builders instead of the devnode fast-path builders.

For mixed control within a single run, the per-call escape hatches override the run-level value: testing `ctx.deploy({ prove })` and `ctx.execute(..., { prove })`, and recipe `ctx.deploy({ prove })` / `ctx.execute(..., { prove })`. For example, `ctx.execute(id, fn, args, { prove: false })` skips proving for one call while the rest of a `--prove` run proves.

Cold-cache prove runs succeed on first use: the SDK transparently downloads credits proving keys (and KZG SRS files for circuits that require them) from the known parameter hosts, written through to the filesystem cache. Subsequent runs hit the cache and skip the network. The egress policy in [`network.md`](network.md) § Egress Policy applies to **network-host** fetches only — chain state and transaction submission — and does not gate parameter downloads. For hermetic / offline test runs, pre-warm the cache and then isolate the test process at the container / CI / firewall level.

`--coverage` is opt-in and enables Vitest V8 coverage for package implementation source. LionDen configures the report to include `packages/*/src/**/*.ts` and exclude package test files, `.d.ts` files, `packages/test-internals`, and checked-in `__goldens__` fixtures. `@vitest/coverage-v8` must be available in the project when this flag is used.

Use `lionden test [files...]` to run a managed Vitest subset while keeping LionDen's compile step, suite hooks, and managed devnode lifecycle:

```bash
lionden test test/orders.test.ts
lionden test test/orders.test.ts test/tally.test.ts --grep orders
lionden test "test/**/*.integration.test.ts"
```

File and glob positionals are passed to Vitest as include patterns with the LionDen project root as Vitest's root. They are not resolved relative to the shell's current working directory. File positionals compose with `--grep`: the file/glob list limits the test files, then Vitest applies the test-name pattern inside those files.

LionDen does not currently prevalidate that each positional path exists. A typo such as `test/oders.test.ts` follows Vitest's no-match behavior; clearer no-matching-file UX is a future enhancement.

## Bring Your Own Network Lifecycle

The managed devnode covers the common case. Some suites instead need to test against a network LionDen does not manage — a containerized multi-validator devnet, a shared staging chain, a fixture network started by the CI job. This is supported today through the `testing` hook category; no flag or config passthrough is required.

The recipe has four parts.

**1. Declare the target as an `http` network, not a `devnode` one.** `type` drives real behavior, not just naming. A `devnode` connection takes `useDevnodeFastPath` — it builds **unproven** transactions that a real network rejects — and it exposes `connection.advanceBlocks`, which POSTs to `<endpoint>/<network>/block/create`, an endpoint only the devnode serves. Under `http` neither applies: transactions are proven and `connection.advanceBlocks` is `undefined`, so height-polling helpers guarded by `if (connection.advanceBlocks)` fall through correctly. `setup()` also gates devnode auto-start on the *target* network's type, so an `http` target needs no `skipDevnode` / `autoStartDevnode` juggling.

Set `ephemeral: true` when the chain dies with its container — `HttpNetworkConfig.ephemeral` defaults to `false`, which would otherwise persist deployment records for a chain that no longer exists.

```typescript
networks: {
  devnet: {
    type: "http",
    endpoint: process.env.DEVNET_ENDPOINT ?? "http://127.0.0.1:3030",
    network: "testnet",
    privateKey: configVariable("DEVNET_DEPLOYER_KEY"),
    ephemeral: true,
  },
},
```

**2. Own the lifecycle from a `suiteSetup` / `suiteTeardown` hook.** Register a local plugin whose `testing` handlers start and stop the network. Because the `test` task dispatches `suiteSetup` in the **parent CLI process**, before Vitest forks any worker, anything the hook writes to `process.env` is inherited by every worker. Workers re-import the project config, so a dynamically discovered endpoint reaches them without a config file rewrite.

Prefer the **lazy factory** form of `hookHandlers`. Workers import the project config too, but never dispatch `testing` hooks — a factory means the container/orchestration module is only ever evaluated in the parent.

Mind the **module specifiers**. The CLI loads the config through tsx and Vitest loads test files through Vite, and both rewrite a `./foo.js` specifier onto `./foo.ts`. Workers do not: they re-import the config with Node's own TypeScript loader, which resolves specifiers literally and fails with `Cannot find module .../foo.js imported from .../lionden.config.ts`. Any local file reachable from the config — the plugin module, and anything it imports at module scope — therefore needs an explicit `.ts` specifier. On a stock generated project (`module`/`moduleResolution: NodeNext`, `declaration: true`) TypeScript rejects those, so a BYO-lifecycle project also needs `allowImportingTsExtensions: true`, which in turn requires `noEmit` or `emitDeclarationOnly`. This bites only the config's own import graph; ordinary test files keep `.js` specifiers because Vite resolves them.

```typescript
// lionden.config.ts
import devnetPlugin from "./test/support/devnet-plugin.ts";

// test/support/devnet-plugin.ts
const devnetPlugin: LionDenPlugin = {
  id: "myproject/devnet",
  hookHandlers: {
    // Lazy: resolved only when the "testing" category is dispatched.
    testing: () => import("./devnet-container.ts"),
  },
};

// test/support/devnet-container.ts — the module namespace *is* the handler map.
let container: StartedTestContainer | undefined;

export async function suiteSetup(context: unknown): Promise<void> {
  container = await new GenericContainer(IMAGE).withExposedPorts(3030).start();
  // Build the endpoint from getHost()/getMappedPort() — a hard-coded
  // 127.0.0.1 is wrong under a remote or VM-backed Docker host.
  process.env.DEVNET_ENDPOINT =
    `http://${container.getHost()}:${container.getMappedPort(3030)}`;
  await waitUntilReady(process.env.DEVNET_ENDPOINT);
}

export async function suiteTeardown(): Promise<void> {
  // Dispatched even when suiteSetup threw — tolerate uninitialized state.
  await container?.stop();
  container = undefined;
}
```

Gate registration on an env variable (`...(process.env.TEST_MODE === "devnet" ? [devnetPlugin] : [])`) so default devnode runs never load the plugin, and pick the network per run with `lionden test --network devnet` — the task bridges it to workers via `LIONDEN_NETWORK`, so test files keep their bare `await setup()`.

**Known gap — prime consensus heights yourself.** `initConsensusHeights()` (exported from `@lionden/network`) primes the SDK's internal consensus-version state from snarkVM's *test* height table. Deploy and execute only call it when `connection.type === "devnode"`. A test devnet reached over `http` runs that same compressed activation schedule, and without priming it rejects the first LionDen-built deployment:

```
Invalid deployment transaction '<id>' - missing program checksum
```

Measured against `aleo-devnet:v4.3.1-v4.8.1`: identical runs fail at the first deploy without the call and pass with it. The mechanism is inferred rather than measured — unprimed, the SDK appears to resolve the consensus version from the production height table and omit the program checksum the chain requires.

Until LionDen primes heights for `http` networks, call it once per process from the project config — the CLI parent and every Vitest worker each hold their own SDK instance, and every one of them imports the config:

```typescript
if (process.env.TEST_MODE === "devnet") {
  const { initConsensusHeights } = await import("@lionden/network");
  await initConsensusHeights();
}
```

This is unrelated to proving. An `http` connection always proves: deploy calls `programManager.deploy()` rather than a `buildDevnode*` builder, and `useDevnodeFastPath` requires `type === "devnode"`. Neither `--prove` nor `LIONDEN_PROVE` is needed, and neither fixes the checksum error.

**3. Precompile, then run with `--no-compile`.** The CLI resolves the config and builds the LRE at **boot**, and `compile` reads that already-resolved config rather than `process.env`. A hook that discovers an endpoint later therefore cannot retarget an in-process compile. When the endpoint is dynamically mapped this is unavoidable, so make it explicit in your scripts:

```bash
lionden compile --network testnet
TEST_MODE=devnet lionden test test/orders.test.ts --network devnet --no-compile
```

LionDen cannot enforce this for you: `compile` runs *before* `suiteSetup` (and outside the hook's error-handling scope), so by the time the hook gets control the decision has already been made. Compile failing means the hook never ran and nothing was started — that ordering is intentional and asserted by the `test` task's contract tests.

**4. One chain per test file.** LionDen sets neither `pool` nor `isolate`, so Vitest defaults apply — `forks` with `isolate: true` — and `fileParallelism` is off unless `--parallel`. Each file gets its own worker and its own LRE. A managed devnode inherits one-chain-per-file for free; a single externally managed network does **not**, so every file in one `lionden test` invocation shares that chain and becomes order-dependent.

If your suite relies on per-file isolation, drive one file per invocation rather than reintroducing a file sequencer:

```bash
for f in test/*.test.ts; do
  TEST_MODE=devnet lionden test "$f" --network devnet --no-compile || exit 1
done
```

A per-file CI matrix is the same shape and parallelizes across runners. Sharing one chain across all files is a legitimate choice too — just make it a deliberate one.

## Vitest Integration

The programmatic Vitest runner currently:

- sets `LIONDEN_PROJECT_ROOT` so worker processes can rediscover the project config
- sets `LIONDEN_CONFIG_PATH` when the parent CLI loaded an explicit config path, so worker processes honor `--config <file>` instead of falling back to the nearest conventional filename
- bridges an explicit `--network` to workers via `LIONDEN_NETWORK` (set only when `--network` was supplied; default runs leave it unset). Workers honor it in `lre-factory`'s `buildLre()`, retargeting `config.defaultNetwork`, and an unknown name throws a clear validation error. A per-call `setup({ network })` still wins over the bridged default. The CLI side of the selection is in [`network.md` § Network Selection And The Worker Bridge](network.md#network-selection-and-the-worker-bridge)
- bridges an explicit `--deploy-backend` to workers via `LIONDEN_DEPLOY_BACKEND`, so `ctx.deploy()` in workers uses the selected backend even though workers rebuild their LRE without the parent's global options. Unlike `LIONDEN_NETWORK`, an ambient `LIONDEN_DEPLOY_BACKEND` is preserved when the flag is absent, because the variable is itself a documented selection layer (see [`deploy-backends.md` § Selecting A Backend](deploy-backends.md#selecting-a-backend))
- suppresses LionDen divider lines for the full managed `lionden test` flow while keeping the surrounding task and transition logs visible
- forwards color support to Vitest workers when the parent terminal supports color and `NO_COLOR`/`FORCE_COLOR` are not already set
- scopes test discovery to `test/**/*.test.ts` by default, or to the provided `lionden test [files...]` include patterns
- applies timeout overrides from task args or config
- optionally enables V8 coverage for package source when `--coverage` is set
- returns summarized pass/fail counts

Vitest remains a peer dependency of `@lionden/plugin-test`. Running `npx vitest` directly is still available, but it bypasses LionDen's compile step, testing hooks, and managed devnode lifecycle.

Managed test runs use a narrow Provable SDK console-noise filter for reviewed progress/status messages and program-endpoint retry chatter. Edition/amendment fallback diagnostics and generic thread-pool startup messages are intentionally left visible in Vitest output. Normal runtime SDK operations also suppress one reviewed edition/amendment fallback message while the wrapped SDK call is running, so script/deploy output is less noisy without muting unrelated errors.

Direct Vitest users can opt in to the same test-output filter that LionDen applies to managed test runs:

```ts
import { defineConfig } from "vitest/config";
import { silenceProvableSdkConsoleNoise } from "@lionden/plugin-test";

export default defineConfig({
  test: { onConsoleLog: silenceProvableSdkConsoleNoise },
});
```

## Fixtures And Assertions

`@lionden/testing` re-exports helpers for:

- fixtures via `loadFixture()` and `clearFixtures()`
- mapping and transaction assertions
- balance assertions
- block-height assertions
- well-known devnode accounts

This lets test suites stay concise without reimplementing common network checks.

## Typed Broadcast Results

The typed-output contract for `.accepted(...)`, `.settled(...)`, and `.rejected(...)` (`EncryptedRecord<T>` / `EncryptedValue<T>` handles, decryption keys, `rawOutputs` transition identity, and the typed-projection error policy) is documented in [`typechain.md` § Typed broadcast results](typechain.md#typed-broadcast-results).

## Building And Recovering Dynamic Records (Leo v4 `dyn record`)

Building `dyn record` inputs with `Leo.dynamicRecord(...)` or generated `codegen.dynamicRecords` helpers, and recovering records from the outputs with generated matchers, are documented in [`typechain.md` § Building and recovering dynamic records](typechain.md#building-and-recovering-dynamic-records-leo-v4-dyn-record).

## Strategy And Design Direction

For the repo-wide test taxonomy, CI lanes, root test scripts, and testing backlog, use [`testing-strategy.md`](testing-strategy.md).

For the rationale behind the Vitest-based testing model, devnode-first assumptions, and known testing constraints, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the testing package and example suites for current reality.
