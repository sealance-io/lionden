---
---

Intentionally empty: no package has been published yet, so this releases nothing and folds into
the initial (pre-v1, ~0.1.0) publish.

Finishes wiring `--network` for tests and makes devnode auto-start target-aware:

- **`test --network <name>` now reaches Vitest workers.** The CLI seeds the explicit `--network`
  into `globalOptions`, the `test` task bridges it to workers via a new `LIONDEN_NETWORK` env var
  (mirroring the `LIONDEN_PROVE` bridge), and each worker's LRE retargets `config.defaultNetwork`
  to it. Previously `--network` mutated only the parent process, so suites silently ran on the
  file default. The bridge is applied only when `--network` is supplied (default runs are
  unchanged), and an unknown bridged network throws a clear validation error.
- **Devnode auto-start is gated on the target network.** `setup()` only auto-starts a managed
  devnode when the network it connects to is itself a `devnode` — a non-devnode/http target no
  longer pays devnode startup (and no longer fails when the binary is missing) for a network it
  never touches. `setup({ network: "<http>", snapshotReset: true })` now fails with a clear
  message instead of starting an unrelated devnode.
- **The *selected* devnode is started.** `setup({ network })` now starts the devnode for the
  network it connects to instead of the config default/first, and that network's
  `socketAddr`/`verbosity`/`genesisPath`/`privateKey` are forwarded to start (previously dropped).
  This fixes a latent start/connect divergence with ≥2 devnode networks (or a single devnode on a
  custom socket), where `setup()` could start one devnode and connect to another.

**Known limitation (N2/N3):** programmatic `tasks.run("deploy"/"recipe"/"upgrade", { network })`
retargets the task's connect/deploy step but not the implicit compile it triggers (compile reads
`config.defaultNetwork`). Use CLI `--network` or precompile per network when these can diverge;
a compiler `effectiveConfig` override is a tracked follow-up.

Since none of this ever shipped, there is no consumer-facing breaking change to flag — these are
corrections to the not-yet-published API (breaking changes are expected pre-v1).
