# Network And Deploy

When to read this: use this file for network config types, connection management, devnode lifecycle, script execution, deployment, and upgrade behavior.

## Current Network Model

`packages/config/src/types.ts` defines two network config variants:

- `devnode`
- `http`

Resolved config stores them under `config.networks` and selects one through `config.defaultNetwork` unless the CLI or task overrides it.

Current defaults include an implicit `devnode` network when the user does not configure any networks.

## Platform Baseline

LionDen uses `devnode` as its built-in lightweight local development target and `http` for connecting to any external network (local or remote, testnet or mainnet).

The framework is intentionally devnode-first. That assumption shapes the default network behavior, the test helpers, and the task surface. Users who need a multi-validator network can run one externally and connect via an `http` network entry.

## Network Manager

`packages/network/src/network-manager.ts` provides `NetworkManagerImpl`, which is injected into the LRE by `@lionden/plugin-network`.

Current responsibilities:

- connect to a named network and reuse active connections
- expose the active connection
- disconnect all open connections
- expose devnode accounts
- proxy `execute()` and `getMappingValue()` to the active connection

Connection creation currently maps:

- `devnode` to `http://<socketAddr>`
- `http` to the configured endpoint

## Devnode Lifecycle

`packages/network/src/devnode-manager.ts` wraps `leo devnode start`.

Current behavior:

- spawns `leo devnode start` (or the binary specified by `leoBinary` in config)
- supports socket address, auto-block, verbosity, genesis path, network selection, and `consensusHeights` (required for Leo v3.5 devnode constructor programs; Leo v4 devnode defaults to V9-active — see [`leo-version-compatibility.md`](leo-version-compatibility.md))
- polls the REST API until healthy
- stops the process with graceful shutdown, then force kill on timeout

`@lionden/plugin-network` exposes this through the `node` task.

Current `node` task flags:

- `--port`
- `--manual-blocks`
- `--network`

The task keeps the process alive until interrupted.

At the platform level, devnode and snarkOS nodes expose the same REST surface for blocks, transactions, programs, mappings, and block height. That is why LionDen can use network endpoints both for runtime interaction and for fetching deployed program sources as compiler dependencies.

## Provable SDK Integration

`packages/network/src/sdk-adapter.ts` is the single point of contact with `@provablehq/sdk`. It loads the SDK module dynamically on first use and initializes the WASM thread pool once per process. All other network and deploy code imports helpers from that module rather than touching the SDK directly.

### SDK objects

`createSdkObjects()` constructs the full SDK object set for a connection: `Account`, `AleoNetworkClient`, `AleoKeyProvider`, `NetworkRecordProvider`, and `ProgramManager`. When a task supplies a custom signer key, `createSignerSdkObjects()` builds an isolated `Account`, `ProgramManager`, and `NetworkRecordProvider` for that signer while sharing the key provider with the default connection.

### Transaction building and broadcasting

The SDK exposes two families of transaction builders: standard methods for real networks and `buildDevnode*` variants that skip proof generation for local development speed. LionDen branches on `connection.type` at every transaction entry point:

| Operation | HTTP network | Devnode |
|---|---|---|
| Deploy | `pm.deploy()` — atomic build + broadcast | `pm.buildDevnodeDeploymentTransaction()` + `broadcastTransaction()` |
| Execute | `pm.execute()` — atomic build + broadcast | `pm.buildDevnodeExecutionTransaction()` + `broadcastTransaction()` (proof-skipping fast path) |
| Upgrade | `pm.buildUpgradeTransaction()` + `broadcastTransaction()` | `pm.buildDevnodeUpgradeTransaction()` + `broadcastTransaction()` |

`pm.deploy()` and `pm.execute()` are atomic on HTTP networks — they build and submit the transaction internally with no separate broadcast step. Upgrade uses a two-step build-then-broadcast approach on both network types.

`broadcastTransaction()` on `AleoConnection` delegates to `AleoNetworkClient.submitTransaction()` from the SDK, so all devnode broadcasts and HTTP upgrade broadcasts go through the same SDK path.

### Devnode guards

Before any devnode transaction is built, two SDK checks run:

- `checkDevnodeSdkSupport()` — verifies that the loaded SDK exposes `buildDevnodeDeploymentTransaction`, `buildDevnodeExecutionTransaction`, and `buildDevnodeUpgradeTransaction`. Throws if the SDK version predates these methods.
- `initConsensusHeights()` — calls `sdk.getOrInitConsensusVersionTestHeights()` to prime the SDK's internal consensus version state. Required for devnode transaction builders; non-fatal if the method is absent in older SDK versions.

### Transaction confirmation

After broadcasting, LionDen polls `GET /{networkId}/transaction/confirmed/{txId}` directly via `fetch` rather than through the SDK. The raw response carries a `block_height` field that the SDK's typed wrapper does not expose, which is why the direct fetch is used here. Polling runs at one-second intervals up to a configurable timeout (default 60 seconds). The `--skip-confirm` flag on `deploy` and `upgrade` bypasses this step.

## Script Execution

The `run` task in `packages/plugin-network/src/index.ts` executes a TypeScript script with the LRE.

Current flow:

1. resolve the target network and connect
2. resolve the script path relative to the project root
3. import the module dynamically
4. call its `default` export if present, otherwise `main`, otherwise rely on side effects

This is the path used by the example deployment scripts.

## Deploy

`packages/plugin-deploy/src/deploy-task.ts` implements the `deploy` task.

Current behavior:

- always runs `compile` first
- discovers programs and libraries from source
- resolves dependency order
- reads compiled programs from the LRE artifact store
- deploys either all compiled programs or a selected program plus its transitive local program dependencies
- connects to the requested network or the default network
- writes a deploy manifest after successful deployment

Current deploy options:

- `--program`
- `--priority-fee`
- `--skip-confirm`
- `--network`

Deploy manifests are written to `artifacts/<programId>/deploy.json`.

Deployment and upgrade behavior are shaped by the Leo upgradability model. In practice that means constructor handling and compatibility checks are part of the deploy subsystem, not an afterthought.

## Upgrade

`packages/plugin-deploy/src/index.ts` also exposes `upgrade`, backed by `upgrade-task.ts`.

The upgrade path is designed to:

- validate upgrade permissions and signer assumptions
- inspect prior deployment state
- enforce ABI compatibility expectations
- write updated deployment state back to the manifest

If you need precise upgrade mechanics, read the deploy plugin source directly before making claims.

## Config Validation

The current default plugins add validation relevant to network and deploy behavior, including:

- default network must exist
- HTTP networks must specify an endpoint
- deploy priority fee cannot be negative
- deploy confirmation timeout must be positive

## Design Direction

For the broader network abstraction, devnode-first rationale, SDK baseline, and constructor-driven upgrade model, use [`vision-and-roadmap.md`](/Users/mitzpetel/Workspaces/lionden/docs/vision-and-roadmap.md). Use the current network and deploy packages for the implementation contract that exists today.
