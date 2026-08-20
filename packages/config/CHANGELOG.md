# @lionden/config

## 0.2.0

### Minor Changes

- [#87](https://github.com/sealance-io/lionden/pull/87) [`360ed41`](https://github.com/sealance-io/lionden/commit/360ed413d9d0640cbd02cca8135d43d6e651ad9b) Thanks [@fullkomnun](https://github.com/fullkomnun)! - Introduce the deploy/upgrade **backend seam** — groundwork for a selectable Leo CLI backend. The
  Provable SDK remains the only backend; no user-visible backend selection is introduced here. Two
  things are observable: the SDK's WASM runtime now loads at the start of `deploy`/`upgrade` rather
  than at first use, so an unusable SDK install fails before compiling instead of after, and an
  unknown `--network` is rejected at the same point rather than after compile/connect.
  
  **Why.** The SDK builds a deployment or upgrade as one monolithic WASM operation, synthesizing and
  retaining proving keys for every function, record circuit, and uncached import until it completes.
  Large programs exhaust WASM's ~4 GiB ceiling during key setup and **hang** — control never returns to
  JavaScript, so the SDK cannot persist partial progress or resume through its `KeyStore`. Past a
  certain program size `lionden deploy` cannot succeed at all. The Leo CLI has no such ceiling and
  caches synthesized keys under `~/.aleo`, so a failed run resumes cheaply.
  
  **`@lionden/config`** — new `DeployProvider` type and `DEPLOY_PROVIDERS` const (`"sdk" | "leo"`), the
  vocabulary the seam is typed against. The user-facing selection built on it (`deploy.backend`,
  `networks.<n>.deployBackend`, `--deploy-backend`, `LIONDEN_DEPLOY_BACKEND`) is described in its own
  entry.
  
  **`@lionden/leo-compiler`** — `resolveBuildArtifacts` and `ResolvedBuildArtifacts` are now exported.
  A backend that hands a materialized package to an external tool must hash the built `.aleo` before
  and after; exporting the compiler's own probe keeps the `build/<name>` layout from drifting between
  compiler and consumer.
  
  **`@lionden/network`** — `deriveAddressFromPrivateKey` is now exported. Previously module-private to
  `named-account-manager.ts`; deploy, upgrade, and preflight each need to derive an address for a
  signer that is not the connection's own. Derivation is a pure local operation and deliberately
  passes no `keyCache`, so it never provisions a filesystem key store as a side effect. Additive only
  — `NetworkConnection` is unchanged, so existing implementors are unaffected.
  
  **`@lionden/plugin-deploy`** — internal restructuring:
  
  - **`DeployBackend` seam.** Deploy and upgrade previously bypassed `NetworkConnection` to call
    `createSdkObjects` directly from seven sites across `deploy-task.ts`, `upgrade-task.ts`, and
    `preflight.ts`. Those sites now go through one boundary (`buildDeploy` / `buildUpgrade` /
    `estimateDeploymentFee` / `preflight`), with `SdkDeployBackend` as the sole implementation.
    Dependency ordering, pending markers, deployment records, confirmation polling, hooks, and export
    are backend-agnostic and unchanged.
  - **Backend preflight is step 0.** `deploy` and `upgrade` resolve the backend and await its
    `preflight()` *before* compiling (deploy) and before connecting (upgrade), so an unusable backend
    fails fast instead of after a full compile. For the SDK backend this loads the WASM runtime up
    front, surfacing a broken `@provablehq/sdk` install immediately.
  - **`--dry-run` gates on a capability.** The check is now
    `backend.capabilities.buildWithoutBroadcast` rather than a hard-coded `connection.type !==
    "devnode"`. SDK-on-HTTP still cannot dry-run (`programManager.deploy` is atomic), so behavior is
    unchanged. A backend that claims the capability and broadcasts anyway is now a hard error rather
    than a silently accepted transaction.
  - **`collectLocalDeploymentClosure`.** Extracted from the traversal that was inlined in
    `resolveDeployTargets` and discarded. Ordered by `graph.order`, includes the root, terminates at
    network dependencies. Needed once a backend must narrow a Leo package's local dependency closure
    to a single program.
  - **Shared deployer-address resolution.** Collapses three near-identical "build an SDK bundle for one
    address" blocks. Signer precedence is unchanged: explicit override, then the connection key, then
    the first devnode account.

- [`5ec7f5f`](https://github.com/sealance-io/lionden/commit/5ec7f5f127b6bcac7a3eafdfc935eda00efa54f7) Thanks [@fullkomnun](https://github.com/fullkomnun)! - Add the **deploy-backend config surface and selection ladder**. Every layer needed to *choose* a
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
  
  **`@lionden/plugin-test`** — `lionden test --deploy-backend <name>` now reaches `TestContext.deploy()`.
  Vitest workers rebuild their own LRE from the config on disk and receive no global options, so the
  `test` task bridges the selected backend across the process boundary through
  `LIONDEN_DEPLOY_BACKEND`, alongside the existing `LIONDEN_NETWORK` and `LIONDEN_PROVE` bridges. An
  explicit flag overrides an ambient `LIONDEN_DEPLOY_BACKEND`; with no flag, the ambient value is
  left alone — unlike `LIONDEN_NETWORK`, which is purely an internal bridge and is cleared when
  absent, `LIONDEN_DEPLOY_BACKEND` is layer 3 of the public ladder and a user may have exported it
  deliberately.
  
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

## 0.1.1

### Patch Changes

- [#76](https://github.com/sealance-io/lionden/pull/76) [`b4a8b28`](https://github.com/sealance-io/lionden/commit/b4a8b28a9ba7d35b1d238313028af5c83321228c) Thanks [@fullkomnun](https://github.com/fullkomnun)! - First release through the automated OIDC trusted-publishing pipeline; ships provenance
  attestations. No functional changes.
