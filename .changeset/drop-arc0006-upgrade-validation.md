---
---

Intentionally empty: no package has been published yet, so this releases nothing and folds into
the initial (pre-v1, ~0.1.0) publish.

Drop the ARC-0006 / upgradability / ABI-compatibility validation scope. lionden no longer encodes
upgrade-correctness rules — that ownership moves to Leo's built-in tooling — and stops persisting the
associated bookkeeping:

- **Thin `upgrade` task.** `upgrade` survives as compile v2 → build upgrade tx → broadcast → record.
  It no longer validates ABI compatibility, constructor immutability, on-chain edition continuity, or
  admin-address identity. The admin key is still selected from `namedAccounts.admin` (selection only,
  no address match). Returns `{ programId, txId, blockHeight }` (no `newEdition`).
- **Removed subsystems.** Deleted `abi-compat.ts`, `admin-signer.ts`, `constructor-parser.ts`, the
  legacy `deploy-manifest.ts`, the upgrade preflight, and `UpgradeCompatibilityError` /
  `validateAdminSigner` / `parseConstructor` / `RecordConstructorInfo` re-exports.
- **Slimmer deployment state.** `DeploymentRecord`, pending markers, history entries, and
  `ExportedProgram` drop `constructor` / `edition` / `abiHash` / `abiChanges`. `ExportedProgram` keeps
  `programId` / `abi` / `txId` / `status`. The `programDeployed` / `programUpgraded` hook payloads are
  now `{ programId, txId, blockHeight, network }`. Old on-disk records with extra fields still parse.
- **ABI retained for `export`.** The in-memory ABI cache, `getCachedAbi()`, and disk ABI snapshots stay;
  `export()` is their consumer (including ephemeral devnode). `manager.record()` still requires `abi`
  for `complete` records.
- **Examples & lane.** Removed only the `upgradeable-counter` example (the lionden-owned
  upgrade walkthrough that embodied the dropped validation flow). The aleo-ports `admin` /
  `noupgrade` / `timelock` ports are **kept** and reframed as Leo constructor/upgrade
  compatibility smoke — Leo and the network own upgrade correctness; lionden does no upgrade
  validation (22 ports remain; `upgrades-vote` kept). Also removed the leo-samples
  `upgradability` suite and `abi_break`.

Mandatory Leo v4 constructor decorators (`@noupgrade` / `@admin` / `@checksum` / `@custom`) remain
required `.leo` syntax — only lionden's tooling and bookkeeping around them were removed.

Breaking changes are expected pre-v1 and need no individual flagging.
