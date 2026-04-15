# Deployment

When to read this: use this file for `deploy`, `upgrade`, `export`, deployment state, deployment preflight, upgradeability rules, and deployment hooks. For network connection, devnode, SDK, and script execution behavior, use [`network.md`](network.md).

## Current Deployment Model

`@lionden/plugin-deploy` provides the deployment subsystem. It registers:

- `deploy`
- `upgrade`
- `export`

It also injects `DeploymentManagerImpl` into `lre.deployments`.

Deployment and upgrade behavior are shaped by the Leo upgradability model. Constructor handling, ABI compatibility, signer checks, on-chain edition checks, and persisted deployment state are part of the deploy subsystem.

## Config

`packages/config/src/types.ts` defines `deploy` config:

- `defaultPriorityFee`: default priority fee in microcredits, default `0`
- `privateFee`: pay fees from private records, default `false`
- `confirmTransactions`: wait for transaction confirmation, default `true`
- `confirmationTimeout`: confirmation timeout in milliseconds, default `60_000`
- `deploymentsDir`: deployment state directory relative to project root, default `deployments`
- `skipDeployed`: skip programs already deployed on-chain, default `true`
- `interDeploymentDelay`: delay between dependent HTTP deployments; default `12_000` for HTTP and `0` for devnode
- `autoExport`: write an export bundle after each deploy or upgrade, default `false`

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
- discovers deployable programs and compile-only libraries from source
- resolves dependency order
- reads compiled programs and ABIs from the LRE artifact store
- deploys either all compiled programs or a selected program plus its transitive local program dependencies
- connects to the requested network or the default network
- runs deploy preflight before broadcasting
- writes deployment state after successful deployment
- fires the `deployment.programDeployed` hook after successful deployment
- optionally exports deployment data

Current deploy options:

- `--program`
- `--priority-fee`
- `--skip-confirm`
- `--network`
- `--no-compile`
- `--preflight`
- `--dry-run`
- `--no-skip-deployed`
- `--export`

`--preflight` runs validation only and does not compile, broadcast, or write deployment state.

`--dry-run` builds deployment transactions without broadcasting. It is currently devnode-only and does not mutate deployment state.

`--no-skip-deployed` makes already-deployed programs a hard preflight error instead of skipping them.

## Deployment Preflight

`packages/plugin-deploy/src/preflight.ts` implements pure validation for deploy and upgrade. It returns structured errors, warnings, and per-program outcomes without writing deployment state.

Deploy preflight checks include:

- constructor annotation presence
- constructor annotation validity
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
  .history/<programId>/<edition>-<timestamp>.json
  .pending/<programId>.json
deployments/_exports/<networkName>.json
```

Files are written with temp-file-plus-rename atomic writes.

The latest record lives at `deployments/<networkName>/<programId>.json`. ABI snapshots live next to records and are used for upgrade compatibility checks. History entries preserve deploy and upgrade events. Pending markers are written before broadcast and removed when a deployment or upgrade is recorded.

Record statuses:

- `complete`: full local provenance from a successful LionDen deploy or upgrade
- `degraded`: program discovered on-chain without full local provenance
- `recovered`: pending marker recovered after a crash or interrupted process

Network metadata is written to `.network.json` for HTTP networks. The deployment manager validates it before trusting disk state so a reconfigured network endpoint does not silently reuse stale deployment records.

Devnode state is memory-first: async reads validate against `getProgramSource()`, and bulk reads/export use the in-memory session cache because devnode disk records may be stale across sessions.

HTTP state is disk-backed after `.network.json` validation.

## Deployment Manager

`packages/plugin-deploy/src/deployment-manager.ts` provides `DeploymentManagerImpl`, exposed as `lre.deployments` by `@lionden/plugin-deploy`.

Current responsibilities:

- validated deployment reads
- cache-only deployment reads
- deployment and upgrade record writes
- ABI snapshot writes and reads
- history reads
- pending marker writes and recovery
- programmatic deploy preflight
- export bundle generation
- devnode session invalidation

The manager depends on the active network manager and artifact store. Plugin authors and scripts should prefer `lre.deployments` for deployment state instead of reading deployment files directly.

## Pending Recovery

Deploy and upgrade write pending markers before broadcasting. On the next deploy or upgrade, `recoverPendingDeployments()` checks pending markers against the active network.

If the program is not on-chain, the marker is cleared. If the program is on-chain, the manager records a `recovered` deployment record using the marker's intended action, expected edition, deployer address, constructor snapshot, ABI hash, network, and endpoint.

## Export Task

`packages/plugin-deploy/src/index.ts` implements `export`.

Current options:

- `--network`
- `--out`

Without `--out`, export writes to `deployments/_exports/<network>.json`. With `--out`, export writes to the requested path.

Export bundles include network metadata and one entry per known program with its program ID, ABI when available, edition, transaction ID when complete, constructor type, admin address when applicable, and record status.

`deploy --export` exports after deployment. `deploy.autoExport` exports after each deploy or upgrade.

## Upgrade Task

`packages/plugin-deploy/src/upgrade-task.ts` implements `upgrade`.

Current behavior:

- requires `--program`
- connects to the requested network or default network
- recovers pending deployments
- reads existing deployment state through `lre.deployments`
- reads the old ABI from deployment state first, then artifacts
- compiles the updated program
- reads the new ABI and compiled Aleo source
- parses the updated constructor
- validates upgrade permission
- runs upgrade preflight
- writes a pending marker
- builds and broadcasts the upgrade transaction
- waits for confirmation unless skipped
- records the updated complete deployment state
- fires the `deployment.programUpgraded` hook
- optionally exports deployment data when `deploy.autoExport` is enabled

Current upgrade options:

- `--program`
- `--priority-fee`
- `--skip-confirm`
- `--network`

Upgrade preflight checks include:

- ABI compatibility
- constructor type, parameter, and fingerprint immutability
- `@admin` signer match
- HTTP on-chain edition continuity
- `@custom` constructor warning

`@noupgrade` records fail upgrade permission validation. `@admin`, `@checksum`, and `@custom` are treated as upgrade-capable paths subject to their validation rules.

## Deployment Hooks

Core defines the `deployment` hook category.

Current deployment hooks:

- `programDeployed`
- `programUpgraded`

`programDeployed` receives program ID, transaction ID, block height, edition, constructor type, and network name.

`programUpgraded` receives the same fields plus `previousEdition`.

## Design Direction

For constructor-driven upgrade intent and platform assumptions, use [`vision-and-roadmap.md`](vision-and-roadmap.md). For Leo version-specific constructor and upgrade compatibility, use [`leo-version-compatibility.md`](leo-version-compatibility.md). Use the current deploy plugin source for the implementation contract that exists today.
