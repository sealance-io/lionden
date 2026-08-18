---
"@lionden/config": minor
"@lionden/core": minor
"@lionden/plugin-deploy": minor
"@lionden/cli": patch
---

Add the **deploy-backend config surface and selection ladder**. Every layer needed to *choose* a
backend for `deploy`/`upgrade` is now live; the Leo backend itself is not. Selecting `"leo"`
resolves, validates the rest of your config against it, and then fails with a clear
"not implemented yet" error. The default is unchanged (`"sdk"`), so a project that sets nothing
behaves exactly as before.

**Breaking (deliberate, pre-1.0).** `ResolvedDeployConfig` gains required `backend` and `leo`.
Reading a config produced by `resolveConfig()` is unaffected — the fields are always populated.
Code that *constructs* a `LionDenResolvedConfig` literal (test fixtures, custom tooling) must add
both. They are required rather than optional so "resolved" keeps meaning resolved: an optional
field would push a `?? "sdk"` default into every consumer, and defaults that live in more than one
place drift.

**`@lionden/config`** — new `deploy.backend?: DeployProvider` (default `"sdk"`) and
`deploy.leo?: { timeout?, logMode? }`, plus `networks.<name>.deployBackend?` for a per-network
override. New exported types `DeployLeoConfig`, `DeployLeoLogMode`, `ResolvedDeployLeoConfig`, and
the `DEPLOY_LEO_LOG_MODES` const.

Two omissions are deliberate. There is no `extraFlags` passthrough for the Leo backend — an
unrestricted one could inject `--broadcast`, `--private-key`, `--endpoint`, `--save`, `--skip`, or
`--no-cache`, each of which breaks a guarantee the backend depends on. And `logMode` has no
`"inherit"` — inherited stdio is wired to the parent's file descriptors and never passes through
JS, so the redaction applied to forwarded output could not hold.

**`@lionden/core`** — `resolveConfig` fills the new fields. `deploy.leo` defaults to a 30-minute
timeout and `"forward"` logging. `networks.<name>.deployBackend` is spread conditionally, so an
unset network stays distinguishable from one that explicitly says `"sdk"` — the precedence order
below depends on that difference.

**`@lionden/plugin-deploy`** — a new `--deploy-backend` global option and the resolution order that
consumes it. Highest first:

1. an explicit `deployBackend` argument (now on the exported `DeployOptions` / `UpgradeOptions`)
2. `--deploy-backend`
3. `LIONDEN_DEPLOY_BACKEND`
4. `networks.<name>.deployBackend`
5. `deploy.backend`
6. `"sdk"`

A value that is present but unrecognized is a hard error at every layer rather than a silent fall
back to the default, so `--deploy-backend Leo` or `--deploy-backend=` fails instead of quietly
deploying with the SDK. The one exception is an empty `LIONDEN_DEPLOY_BACKEND`, which reads as
unset — `FOO=` is an ordinary way to clear a shell variable, and `parseBooleanEnv` already treats
it that way.

Recipes and `TestContext.deploy()` deliberately gain no per-call override: they dispatch the deploy
task, so they inherit whatever layers 2–6 resolve to. A per-program knob inside one run would let a
single recipe be deployed half by Leo and half by the SDK.

Compatibility validation runs on the **effective** backend, not on `deploy.backend`, because config
resolution happens before the CLI flag and environment variable exist and would miss Leo selected
through either. With Leo selected it rejects a configured `sdk.egress` (the policy is enforced
inside the SDK's network transport, which the Leo CLI does not go through), a network `apiKey`
(Leo 4.3 `deploy`/`upgrade` expose no API-key or header option, so its queries would go out
unauthenticated), and a `leoVersion` outside `4.3.x`. It warns — without failing — that a
filesystem `sdk.keyCache` goes unused, since Leo caches under `~/.aleo`. Every rejection names the
offending config path and offers `--deploy-backend sdk`.

**`@lionden/cli`** — `--deploy-backend` is validated once, centrally, before a task is dispatched,
following the existing `--network` precedent. A value-less `--deploy-backend` is rejected rather
than ignored: the parser deliberately does not consume a task token as an option value (so
`lionden --deploy-backend deploy` still runs `deploy`), which means checking only the parsed value
would treat it as unset.
