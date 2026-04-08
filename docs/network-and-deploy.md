# Network And Deploy

When to read this: use this file for network config types, connection management, devnode/devnet lifecycle, script execution, deployment, and upgrade behavior.

## Current Network Model

`packages/config/src/types.ts` defines three network config variants:

- `devnode`
- `devnet`
- `http`

Resolved config stores them under `config.networks` and selects one through `config.defaultNetwork` unless the CLI or task overrides it.

Current defaults include an implicit `devnode` network when the user does not configure any networks.

## Platform Baseline

LionDen is designed around two local-development modes:

- `devnode`: lightweight single-node local development, the primary inner-loop target
- `devnet`: fuller local network simulation for broader integration coverage

The framework is intentionally devnode-first. That assumption shapes the default network behavior, the test helpers, and the task surface.

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
- `devnet` to a local REST endpoint derived from `restPort`
- `http` to the configured endpoint

## Devnode Lifecycle

`packages/network/src/devnode-manager.ts` wraps `leo devnode start`.

Current behavior:

- spawns `leo devnode start`
- supports socket address, auto-block, verbosity, genesis path, and network selection
- polls the REST API until healthy
- stops the process with graceful shutdown, then force kill on timeout

`@lionden/plugin-network` exposes this through the `node` task.

Current `node` task flags:

- `--port`
- `--manual-blocks`
- `--network`

The task keeps the process alive until interrupted.

At the platform level, devnode and devnet expose the same style of REST surface for blocks, transactions, programs, mappings, and block height. That is why LionDen can use network endpoints both for runtime interaction and for fetching deployed program sources as compiler dependencies.

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
