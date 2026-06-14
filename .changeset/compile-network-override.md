---
---

Intentionally empty: no package has been published yet, so this releases nothing and folds into
the initial (pre-v1, ~0.1.0) publish.

Makes the implicit compile follow the effective deployment network (N2/N3):

- **Programmatic `tasks.run("deploy"/"recipe"/"upgrade", { network })` now retargets the implicit
  compile's network-dependency fetch.** Previously the compile pipeline always resolved imported
  on-chain program sources (`GET /{network}/program/{id}`) against `config.defaultNetwork`'s
  endpoint and network hint, so deploying program P to network `X` while the file default was
  devnode fetched P's on-chain imports from devnode — wrong/missing source linked into the build.
  The deploy/recipe/upgrade tasks now forward the requested network into compile as an internal
  `CompileOptions.network` passthrough, and `compilePipeline` resolves the endpoint + `networkHint`
  from `config.networks[network]`. This is the primary, correctness-facing fix.
- **The materialized `.env` honors the deploying network too** (secondary cleanup). `buildDotEnv`
  emits the effective network's `NETWORK`/`ENDPOINT`/`PRIVATE_KEY`/`DEVNET` instead of the default's.
  Evidence shows LionDen does not feed `.env` into `leo build` or the compilation cache key, so for
  local-only programs this divergence was cosmetic; the change keeps `.env` honest regardless.
- **`network` is an internal override, not a CLI flag.** `--network` remains a reserved built-in
  global that mutates `config.defaultNetwork` pre-dispatch; the compile task reads `network` only as
  an undeclared passthrough arg (it cannot declare a `network` option — reserved globals are rejected
  at plugin load). An explicit network absent from `config.networks` throws a clear validation error
  before any fetch, so an unknown network never silently falls back to `http://127.0.0.1:3030`.
- **Default and CLI runs are byte-for-byte unchanged.** The network is forwarded only when explicitly
  supplied; absent, compile uses `config.defaultNetwork` exactly as before. CLI `--network` already
  mutates `config.defaultNetwork` pre-dispatch, so the forward is a redundant-but-harmless no-op there.

Since none of this ever shipped, there is no consumer-facing breaking change to flag.
