---
---

Intentionally empty: no package has been published yet, so this releases nothing and folds into
the initial (pre-v1, ~0.1.0) publish.

Pre-release hardening from the round-3 e2e bug hunt:

- **`--prove` is a built-in framework global.** Resolved in any position for `deploy`, `upgrade`,
  `recipe`, and `test`; honours an ambient `LIONDEN_PROVE`; the name is reserved. Adds per-call
  `prove?: boolean` escape hatches and a `parseBooleanEnv` helper exported from `@lionden/config`.
- **`test --network <name>` reaches Vitest workers** via a `LIONDEN_NETWORK` bridge, and devnode
  auto-start is target-aware — `setup()` starts and connects to the *selected* devnode (forwarding
  its socket/verbosity/genesis/key), not the config default/first.
- **The implicit compile follows the effective deployment network.** Programmatic
  `tasks.run("deploy"/"recipe"/"upgrade", { network })` now retargets the compile's
  network-dependency fetch (`GET /{network}/program/{id}`) and the materialized `.env` to the
  deploying network instead of `config.defaultNetwork`. `network` is threaded as an internal
  `CompileOptions` passthrough, not a CLI flag (`--network` stays a reserved global that mutates
  `config.defaultNetwork`).
- **Slimmed plugin/task/hook core.** Removed never-wired surface (`conditionalDependencies`, lazy
  task actions, `HookDispatcher.parallel`, the `"compilation"`/`"network"` hook categories); added
  `HookDispatcher.collect()` and routed the config lifecycle through it; positional task arguments
  are now bound by name with `required` enforced.

Breaking changes are expected pre-v1 and need no individual flagging.
