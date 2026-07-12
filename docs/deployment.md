# Deployment

When to read this: use this file for `deploy`, `upgrade`, `export`, deployment state, deployment preflight, and deployment hooks. For network connection, devnode, SDK, and script execution behavior, use [`network.md`](network.md).

## Current Deployment Model

`@lionden/plugin-deploy` provides the deployment subsystem. It registers:

- `deploy`
- `upgrade`
- `export`
- `recipe`

It also injects `DeploymentManagerImpl` into `lre.deployments`.

The deploy subsystem owns transaction building, broadcast, and persisted deployment state. The `upgrade` task is thin: it compiles the updated program, builds and broadcasts the upgrade transaction, and records a minimal updated record. LionDen does not validate ABI compatibility, constructor immutability, or edition continuity — Leo's built-in tooling owns upgrade correctness.

## Config

`packages/config/src/types.ts` defines `deploy` config:

- `defaultPriorityFee`: default priority fee in microcredits, default `0`
- `privateFee`: pay fees from private records, default `false`
- `confirmTransactions`: wait for transaction confirmation, default `true`
- `confirmationTimeout`: confirmation timeout in milliseconds, default `60_000`
- `deploymentsDir`: deployment state directory relative to project root, default `deployments`
- `skipDeployed`: skip programs already deployed on-chain, default `true`
- `interDeploymentDelay`: delay between dependent HTTP deployments; default `12_000` for HTTP and `0` for devnode
- `autoExport`: write an export bundle after confirming each deploy or upgrade, default `false`
- `ephemeral`: global ephemeral override — when `true`, all networks skip deployment-state disk reads/writes except export bundles; when `false`, forces disk-backed deployment state even on devnode (overridden by per-network setting)

Per-network config also accepts `ephemeral?: boolean` to override the type-based default for that network.

Resolved paths include `config.paths.deployments`, the absolute path for deployment state.

`@lionden/plugin-deploy` validates:

- deploy priority fee cannot be negative
- deploy confirmation timeout must be positive
- deploy inter-deployment delay cannot be negative
- deployments directory cannot be empty

## Deploy Task

`packages/plugin-deploy/src/deploy-task.ts` implements `deploy`.

Current behavior:

- compiles first unless `--no-compile` or `--preflight` is set
- scopes that implicit compile to the selected program and its compile dependencies when `--program` is set
- discovers deployable programs and compile-only libraries from source
- resolves dependency order
- reads compiled programs and ABIs from the LRE artifact store
- deploys either all compiled programs or a selected program plus its transitive local program dependencies
- connects to the selected config network (`config.defaultNetwork`, possibly overridden by the global CLI `--network <name>`)
- runs deploy preflight before broadcasting
- records deployment state after successful deployment with initial `edition: 0` (in memory for ephemeral networks, on disk for non-ephemeral networks)
- fires the `deployment.programDeployed` hook after successful deployment
- optionally exports deployment data after confirming the deploy

Current deploy options:

- `--program`
- `--rename`
- `--priority-fee`
- `--skip-confirm`
- `--no-compile`
- `--preflight`
- `--dry-run`
- `--no-skip-deployed`
- `--export`

`--preflight` runs validation only and does not compile, broadcast, or write deployment state.

`--dry-run` builds deployment transactions without broadcasting. It is currently devnode-only and does not mutate deployment state.

`--no-skip-deployed` makes already-deployed programs a hard preflight error instead of skipping them.

`--export` requires deploy confirmation. `deploy --skip-confirm --export` is rejected before deployment side effects because the deployed program may not yet be visible to validated export reads. `deploy.autoExport` runs for confirming deploys and upgrades; non-confirming deploys and upgrades skip auto-export.

### Deploy Rename

`deploy --program <source> --rename <name>` deploys one local source program under a different on-chain program id. The source identity remains the local program selected from `programs/`; the runtime identity is the normalized rename target (`<name>.aleo` when the suffix is omitted). LionDen compiles the selected source through its normal SDK-backed deploy path and does not shell out to `leo deploy`.

Rename is supported only when `leoVersion` is `4.3.0` or newer. The deploy task validates rename before compilation, network connection, pending markers, or deployment writes for the checks it owns at that stage: `leoVersion`, `compiler.buildTests`, the requirement that `--rename` is paired with `--program`, and local name collisions. Only the primary deploy target is renamed; imports keep their source-authored ids. For example, if `hello.aleo` imports `token.aleo`, deploying `hello` as `renamed_hello.aleo` still imports `token.aleo`.

Deployment records are keyed by the deployed/runtime `programId`. Renamed records also include `sourceProgramId` so upgrade can recompile the local source program with the recorded runtime rename instead of treating the on-chain id as the local source id. Renamed upgrades require that recorded provenance and `leoVersion` 4.3.0 or newer.

Rename support is defined around the actual deploy flow, wrapper/test/recipe deploy helpers, and renamed upgrade using recorded provenance. `deploy --rename --preflight` is not expanded into a hidden compile or rename-planning flow: on HTTP, preflight still reads the renamed runtime artifact by its runtime id, so a clean rename preflight expects that renamed artifact to already exist locally. This keeps preflight semantics unchanged rather than compiling during preflight.

### `--prove` (global)

`--prove` is a framework **built-in global** (like `--network`), not a deploy-task flag — it works in any position (`lionden --prove deploy`, `lionden deploy --prove`) and on `upgrade`/`recipe`/`test` too. `deploy`/`upgrade` resolve it via `resolveProveOption()` (precedence: a programmatic per-call arg → the `--prove`/`--prove=false` global → a truthy `LIONDEN_PROVE` env → `false`). A truthy `LIONDEN_PROVE` is parsed permissively (`1`/`yes`/`on`/…); an explicit `--prove=false` reliably wins over the env.

**Devnode-scoped applicability**: proving selects the standard/proven ProgramManager builders instead of the devnode fast-path builders — this only matters on devnode. On a configured HTTP target the standard builders are always used, so `--prove` is a no-op for builder selection there.

## Deployment Preflight

`packages/plugin-deploy/src/preflight.ts` implements pure validation for deploy. It returns structured errors, warnings, and per-program outcomes without writing deployment state.

Deploy preflight checks include:

- on-chain already-deployed status
- imported program availability on HTTP networks
- deployment fee estimation on HTTP networks when the SDK supports it
- deployer balance sufficiency on HTTP networks

Preflight can return `deploy` or `skip` outcomes per program. A skipped program may already be tracked in local state or may be discovered on-chain without local provenance.

## Deployment State

Deployment state is stored under `config.paths.deployments`.

Current layout:

```text
deployments/<networkName>/
  .network.json
  <programId>.json
  <programId>.abi.json
  .history/<programId>/<historyCount>-<timestamp>.json
  .pending/<programId>.json
deployments/_exports/<networkName>.json
```

Files are written with temp-file-plus-rename atomic writes.

The latest record lives at `deployments/<networkName>/<programId>.json`. ABI snapshots live next to records and are retained for export. History entries preserve deploy and upgrade events. Pending markers are written before broadcast and removed when a deployment or upgrade is recorded.

Record statuses:

- `complete`: full local provenance from a successful LionDen deploy or upgrade
- `degraded`: program discovered on-chain without full local provenance
- `recovered`: pending marker recovered after a crash or interrupted process

Deployment records include numeric `edition`. First-time deploy records use
`edition: 0`, the protocol initial edition. Confirmed upgrades record the
edition observed on-chain after confirmation. `upgrade --skip-confirm` is the
explicit exception: because confirmation and post-upgrade observation are
skipped, LionDen records `previousEdition + 1` locally. Degraded and recovered
records created from on-chain state use the observed on-chain edition. If the
active network cannot provide the edition for a path that requires it, record
creation, upgrade recording, or pending recovery fails instead of storing
partial state.
`historyCount` remains local deployment-history bookkeeping and is not used as
the source of truth for program edition.

Network metadata is written to `.network.json` for HTTP networks. The deployment manager validates it before trusting disk state so a reconfigured network endpoint does not silently reuse stale deployment records.

### Ephemeral mode

Devnode networks default to **ephemeral mode**: all deployment state is kept in memory only. No records, ABI snapshots, pending markers, or history entries are written to disk, and disk reads are skipped entirely. This prevents stale files from a previous session being rehydrated when a new devnode process starts.

HTTP networks default to **non-ephemeral** (disk-backed) behavior.

The `ephemeral` default can be overridden:

```typescript
networks: {
  // Force disk persistence on devnode (unusual — useful for debugging):
  devnode: { type: "devnode", ephemeral: false },
  // Ephemeral HTTP (unusual):
  testnet: { type: "http", endpoint: "...", network: "testnet", ephemeral: true },
},
deploy: {
  // Global fallback — applies to any network that doesn't set ephemeral explicitly:
  ephemeral: true,
},
```

Resolution order: `network.ephemeral ?? deploy.ephemeral ?? (type === "devnode")`.

**Export exception**: `export()` always writes to `deployments/_exports/<network>.json` even in ephemeral mode. Export bundles are intentionally useful for ephemeral devnode (frontend dev integration, CI artifacts).

**In-memory ABI cache**: `record()` populates an in-memory ABI cache alongside the deployment record cache. `export()` reads this cache to emit per-program ABI on ephemeral networks, where no on-disk ABI snapshot exists. ABIs stored in the cache are normalized through `parseAbi()` to ensure consistent internal format regardless of how the ABI was originally provided.

## Deployment Manager

`packages/plugin-deploy/src/deployment-manager.ts` provides `DeploymentManagerImpl`, exposed as `lre.deployments` by `@lionden/plugin-deploy`.

Current responsibilities:

- validated deployment reads
- cache-only deployment reads
- deployment and upgrade record writes
- ABI snapshot writes and reads (gated by ephemeral mode)
- in-memory ABI cache (used by `export()` in ephemeral mode)
- history reads
- pending marker writes and recovery
- programmatic deploy preflight
- export bundle generation
- session invalidation (clears both record cache and ABI cache)

Key interface methods include `isEphemeral(network)` (returns the resolved ephemeral flag for a network) and `getCachedAbi(programId, network)` (returns the normalized in-memory ABI or null).

The manager depends on the active network manager and artifact store. Plugin authors and scripts should prefer `lre.deployments` for deployment state instead of reading deployment files directly.

## Deployment Context

Deployment recipes receive a `DeploymentContext`. Its `deploy()` helper accepts
a bare program name, a `.aleo` program id, or a generated wrapper with a
`programId` property. Deployment state and skip/reuse behavior remain owned by
the context and deploy subsystem; wrappers remain typed ABI clients.

Passing a wrapper is pure sugar for passing its `programId` — `deploy()` reads
that field. Generated wrappers may also carry `sourceProgramId`; when
`sourceProgramId !== programId`, `deploy()` deploys the local source program
with `rename` set to the wrapper's runtime `programId`. It does **not** deploy
the wrapper's runtime `imports` (those are execution-time dispatch targets, see
[Runtime Imports For Dynamic Dispatch](./network.md#runtime-imports-for-dynamic-dispatch));
dependency deploy order still follows static `import`s.

## Pending Recovery

On non-ephemeral networks, deploy and upgrade write pending markers before broadcasting. On the next deploy or upgrade, `recoverPendingDeployments()` checks pending markers against the active network. Ephemeral networks skip pending marker writes and pending recovery because the chain and deployment state are memory-only for the session.

If the program is not on-chain, the marker is cleared. If the program is on-chain, the manager records a `recovered` deployment record using the marker's intended action, deployer address, network, endpoint, observed on-chain edition, and any confirmed transaction provenance already written to the marker.

## Export Task

`packages/plugin-deploy/src/index.ts` implements `export`.

Current options:

- `--out`

Without `--out`, export writes to `deployments/_exports/<network>.json`. With `--out`, export writes to the requested path.

Export bundles include network metadata and one entry per known program (`ExportedProgram`) with its program ID, ABI when available, transaction ID when complete, and record status.

`deploy --export` exports after a confirming deployment. It is rejected with `--skip-confirm` because validated export may race on-chain propagation. `deploy.autoExport` exports after confirming deploys and confirming upgrades; non-confirming deploys and upgrades skip auto-export.

## Upgrade Task

`packages/plugin-deploy/src/upgrade-task.ts` implements `upgrade`. It is a thin task: it builds and broadcasts the upgrade transaction and records a minimal updated record. It does **not** validate ABI compatibility, constructor immutability, edition continuity, or admin identity, and it does not read the old or deployed ABI. Leo's built-in tooling owns upgrade correctness.

Current behavior:

- requires `--program`
- connects to the requested network or default network
- recovers pending deployments
- uses an existing local deployment record when present
- if no local record exists but the program is already on-chain, treats it as degraded/untracked state and can still attempt the upgrade
- compiles the updated program
- reads the new compiled Aleo source
- writes a pending marker on non-ephemeral networks
- builds and broadcasts the upgrade transaction
- waits for confirmation unless skipped
- records the updated deployment state (in memory for ephemeral networks, on disk for non-ephemeral networks)
- fires the `deployment.programUpgraded` hook
- optionally exports deployment data after confirming the upgrade when `deploy.autoExport` is enabled

The task returns `{ programId, txId, blockHeight }`.

Current upgrade options:

- `--program`
- `--priority-fee`
- `--skip-confirm`

When `namedAccounts.admin` is set, the upgrade task selects its private key as the signing key (selection only — there is no address-match validation).

LionDen still does not validate the old ABI or admin identity before upgrading; Leo and the target network enforce upgrade correctness.

## Deployment Recipes

`packages/plugin-deploy/src/recipe-task.ts` implements the `recipe` task. Recipes are TypeScript modules that export a function accepting a `DeploymentContext` and returning a `Promise`. They provide a reusable, composable way to set up state across both tests and CLI.

```typescript
// recipes/setup.ts
import type { DeploymentContext } from "@lionden/plugin-deploy";

export default async function setup(ctx: DeploymentContext) {
  await ctx.deploy("token");
  await ctx.deploy("vault");
}
```

Run from CLI:

```
lionden recipe --file ./recipes/setup.ts
lionden recipe --file ./recipes/setup.ts --export setup  # named export
lionden recipe --file ./recipes/setup.ts --network testnet
lionden recipe --file ./recipes/setup.ts --no-compile
```

The recipe task compiles all programs once before running the recipe function. Individual `ctx.deploy()` calls default to `{ noCompile: true }` to avoid redundant compilation in multi-deploy recipes.

`ctx.deploy()` may return an existing complete deployment record when the requested program is already deployed and local state has a `txId`. Degraded or recovered records are not returned because they are not full local deployment provenance. Use `{ noSkipDeployed: true }` for first-time-only recipes that should fail instead of reusing or skipping an existing deployment.

`DeploymentContext` provides:

- `deploy(programName, opts?)` — deploys a program or returns a cached complete deployment as `{ programId, txId }`
- `execute(programId, transitionName, args, opts?)` — executes a transition
- `accounts` — well-known devnode accounts (empty array on HTTP networks)
- `namedAccounts` — resolved named accounts for the active network (see [Named Accounts](#named-accounts))
- `named` — DSL for required named account roles, e.g. `ctx.named.signer("deployer")`
- `connection` — the active `NetworkConnection`
- `lre` — the full `LionDenRuntimeEnvironment`
- `network` — the connected network name

`TestContext` in `@lionden/testing` structurally satisfies `DeploymentContext` via TypeScript structural typing — no import or explicit `extends` needed. A recipe written for the CLI can be called directly from a test fixture.

Types are exported from `@lionden/plugin-deploy`: `DeploymentContext`, `DeploymentRecipe`, `RecipeDeployOptions`, `RecipeDeployResult`, `RecipeExecuteOptions`, `RecipeExecuteResult`.

## Named Accounts

Named accounts map human-readable role names (e.g. `deployer`, `admin`, `treasury`) to per-network account values. They solve three problems:

1. **Readability**: `ctx.named.signer("deployer")` is clearer than `ctx.accounts[0]`.
2. **Network portability**: the same recipe/test runs on devnode (using pre-funded indices) and testnet/mainnet (using real keys from env vars) without code changes.
3. **Address-only roles**: a `treasury` receiver only needs an address, not a private key.

### Config

```typescript
import { defineConfig, configVariable } from "@lionden/config";

export default defineConfig({
  namedAccounts: {
    deployer: {
      default: 0,                                  // devnode: DEVNODE_ACCOUNTS[0]
      // testnet: configVariable("DEPLOYER_KEY"),  // uncomment when targeting testnet
    },
    treasury: {
      default: "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5",
    },
  },
});
```

> **Eager resolution**: all `configVariable()` values in `namedAccounts` are resolved during config load, before a network is selected. If an entry references an env var (e.g. `configVariable("DEPLOYER_KEY")`), that env var must be set even on devnode runs. Use per-network overrides only for the networks you actively target, and keep others commented out if the env var is not always available.

Value types:
- **number** — devnode account index (e.g. `0` → `DEVNODE_ACCOUNTS[0]`). Throws if used with an HTTP network.
- **`aleo1...` string** — a literal Aleo address. Becomes an `AddressOnlyNamedAccount` (no private key).
- **`APrivateKey1...` string** — a literal private key. Address derived at runtime.
- **`ConfigVariable`** — resolved eagerly from environment variables, then classified by prefix.

### Runtime types

Two named account shapes exist (from `@lionden/config`):

```typescript
// Has a private key — can sign transactions
interface SignableNamedAccount {
  type: "signable";
  name: string;
  address: string;
  privateKey: string;
}

// Address only — cannot sign
interface AddressOnlyNamedAccount {
  type: "address-only";
  name: string;
  address: string;
}

type NamedAccount = SignableNamedAccount | AddressOnlyNamedAccount;
```

`SignableNamedAccount` structurally satisfies `Signer` — pass it directly to `ExecuteOptions.signer`.

`DeploymentContext` and `TestContext` expose `ctx.named`, a DSL for declaring the account role a recipe needs:

- `ctx.named.signer(name)` — returns a required `SignableNamedAccount`
- `ctx.named.address(name)` — returns a required `NamedAccount`; the role contract is "an address is enough", but the return value is the full named account object, not a bare string
- `ctx.named.require({ roleName: "signer" | "address" })` — validates several roles at once and returns a typed object

The lower-level `@lionden/config` helpers remain available for compatibility:
- `isSignable(account)` — type guard for optional or raw named-account values
- `requireNamedAccount(namedAccounts, name)` — deprecated; prefer `ctx.named.address(...)`
- `requireSignableNamedAccount(namedAccounts, name)` — deprecated; prefer `ctx.named.signer(...)`
- `asSigner(account)` — deprecated; values returned by `ctx.named.signer(...)` can be passed directly as signers

### Using named accounts in recipes and tests

```typescript
import type { DeploymentRecipe } from "@lionden/plugin-deploy";

// In a recipe:
export const setupToken: DeploymentRecipe = async (ctx) => {
  const { deployer, treasury } = ctx.named.require({
    deployer: "signer",
    treasury: "address",
  });
  await ctx.deploy("token", { noSkipDeployed: true });

  await ctx.execute("token.aleo", "mint_public", [treasury.address, "10000u64"], {
    signer: deployer,
  });
};

// In a test:
it("admin action uses named admin", async () => {
  const admin = ctx.named.signer("admin");
  await ctx.execute("token.aleo", "admin_only", ["arg"], { signer: admin });
});
```

If a required role is absent from the resolved named-account record, or if an address-only account is used where a signer is required, the accessor throws a contract error for the connected network:

```text
Named accounts contract failed for network "devnode":
  - "treasury" is not configured
  - "deployer" is address-only but the contract requires a signer
```

Network-specific config gaps, such as a named account with neither a matching network override nor a default, are still reported earlier during network connection.

### Deploy/upgrade signer integration

When `namedAccounts.deployer` is configured as a `SignableNamedAccount`, the deploy task uses its private key for transaction signing instead of `connection.privateKey`. The same private key is used for both the transaction and the recorded `deployerAddress`.

When `namedAccounts.deployer` is `AddressOnlyNamedAccount`, the deploy task throws — the deployer role requires a signing key.

When `namedAccounts.admin` is configured for the upgrade task and is signable, it is selected as the transaction signer. This is selection only — there is no address-match validation against the on-chain admin.

## Deployment Hooks

Core defines the `deployment` hook category.

Current deployment hooks:

- `programDeployed`
- `programUpgraded`

`programDeployed` receives program ID, transaction ID, block height, and network name.

`programUpgraded` receives the same fields.

## Design Direction

For platform assumptions and design framing, use [`vision-and-roadmap.md`](vision-and-roadmap.md). For Leo version-specific constructor and upgrade compatibility, use [`leo-version-compatibility.md`](leo-version-compatibility.md). Use the current deploy plugin source for the implementation contract that exists today.
