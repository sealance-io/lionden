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
- `--network`

The task keeps the process alive until interrupted.

At the platform level, devnode and snarkOS nodes expose the same REST surface for blocks, transactions, programs, mappings, and block height. LionDen uses network endpoints both for runtime interaction and for fetching deployed program sources as compiler dependencies.

## Provable SDK Integration

`packages/network/src/sdk-adapter.ts` is the single point of contact with `@provablehq/sdk`. It loads the SDK module dynamically on first use and initializes the WASM thread pool once per process. Other network and deploy code imports helpers from that module rather than touching the SDK directly.

### SDK Objects

`createSdkObjects()` constructs the full SDK object set for a connection: `Account`, `AleoNetworkClient`, `AleoKeyProvider`, `NetworkRecordProvider`, and `ProgramManager`.

When a task supplies a custom signer key, `createSignerSdkObjects()` builds an isolated `Account`, `ProgramManager`, and `NetworkRecordProvider` for that signer while sharing the key provider with the default connection.

### Transaction Building And Broadcasting

The SDK exposes two families of transaction builders: standard methods for real networks and `buildDevnode*` variants that skip proof generation for local development speed. LionDen branches on `connection.type` at every transaction entry point:

| Operation | HTTP network | Devnode |
| --- | --- | --- |
| Deploy | `pm.deploy()` - atomic build + broadcast | `pm.buildDevnodeDeploymentTransaction()` + `broadcastTransaction()` |
| Execute | `pm.execute()` - atomic build + broadcast | `pm.buildDevnodeExecutionTransaction()` + `broadcastTransaction()` |
| Upgrade | `pm.buildUpgradeTransaction()` + `broadcastTransaction()` | `pm.buildDevnodeUpgradeTransaction()` + `broadcastTransaction()` |

`pm.deploy()` and `pm.execute()` are atomic on HTTP networks: they build and submit the transaction internally with no separate broadcast step. Upgrade uses build-then-broadcast on both network types.

`broadcastTransaction()` on `AleoConnection` delegates to `AleoNetworkClient.submitTransaction()` from the SDK, so devnode broadcasts and HTTP upgrade broadcasts go through the same SDK path.

### Devnode Guards

Before any devnode transaction is built, two SDK checks run:

- `checkDevnodeSdkSupport()` verifies that the loaded SDK exposes `buildDevnodeDeploymentTransaction`, `buildDevnodeExecutionTransaction`, and `buildDevnodeUpgradeTransaction`.
- `initConsensusHeights()` calls `sdk.getOrInitConsensusVersionTestHeights()` to prime the SDK's internal consensus version state. This is required for devnode transaction builders and is non-fatal if the method is absent in older SDK versions.

### Transaction Confirmation

After broadcasting, LionDen polls `GET /{networkId}/transaction/confirmed/{txId}` directly through `fetch` rather than through the SDK. The raw response carries a `block_height` field that the SDK's typed wrapper does not expose. Polling runs at one-second intervals up to `config.deploy.confirmationTimeout`, defaulting to 60 seconds.

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
