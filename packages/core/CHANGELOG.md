# @lionden/core

## 0.2.0

### Minor Changes

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

- [`80f7f5f`](https://github.com/sealance-io/lionden/commit/80f7f5fabdcff36e054648a1fb1aab0a9b647642) Thanks [@fullkomnun](https://github.com/fullkomnun)! - Implement the **Leo CLI deploy backend** for `deploy`. `--deploy-backend leo`
  now builds real deployment transactions by invoking the Leo CLI, instead of
  failing with "not implemented yet".
  
  **Why this exists.** The Provable SDK builds a deployment in one monolithic WASM
  operation, synthesizing and retaining proving keys for every function, record
  circuit and uncached import until it completes. Large programs can exhaust
  WASM's ~4 GiB limit during key setup and hang before control returns to
  JavaScript, so the SDK cannot persist partial progress or resume. The Leo CLI
  caches synthesized keys under `~/.aleo`, so a failed or timed-out run resumes
  cheaply. This is a capability gap, not a preference — `capabilities.resumableKeySynthesis`
  is the flag that records it.
  
  **Leo builds; lionden broadcasts.** The backend runs `leo deploy --save` without
  `--broadcast` and hands the resulting transaction back, so dependency ordering,
  pending markers, deployment records, confirmation polling and hooks all stay
  exactly where they were. The saved file is a bare snarkVM transaction and is
  broadcast byte for byte.
  
  **Scope.** `deploy`, on devnode networks. `upgrade` and HTTP support land in the
  companion change alongside their security prerequisites. Fee estimation returns the existing
  `FEE_ESTIMATION_UNAVAILABLE` warning rather than an estimate; the SDK path is no
  better there, since `estimateDeploymentFee` synthesizes keys and hits the same
  memory wall as the deploy it is estimating.
  
  **Correctness guards**, each covering a way the Leo CLI can quietly do the wrong
  thing:
  
  - **Exit code 0 never means success.** Leo exits 0 when `--skip` matches every
    program, and also when a broadcast transaction is rejected on chain. Success
    is never inferred from the exit code: it requires the expected
    `<program-id>.deployment.json` to exist *and* to validate (see below). A run
    that produces more than one transaction is rejected too.
  - **`--skip` collisions are refused up front.** Leo matches skips by substring,
    so a dependency `hello.aleo` would also suppress a target named
    `renamed_hello.aleo` — a silent no-op deployment. The check names both ids.
  - **The package is hashed before and after the run.** `leo deploy` recompiles
    from `src/` when `src/` is newer than `build/`, and overwrites `build/` when
    it does. If the compiled program changes during the run, the transaction is
    discarded **before broadcast** rather than recorded under bytecode lionden
    never built.
  - **The Leo binary's version is checked independently.** `skipLeoVersionCheck`
    does not relax it and `--noCompile` does not skip it, because both otherwise
    let a 3.5 or 4.1 binary reach a 4.3-only flag surface.
  - **The saved transaction is validated, not just named.** The file name is Leo's
    label for the blob; the bytes are parsed and checked to be a deployment
    transaction declaring the requested program before anything is broadcast or
    recorded. An empty or truncated write, or a stale file under the right name,
    is refused. The original bytes are broadcast unchanged — never re-serialized.
  
  **Security.** The signing key is passed through the child environment and never
  in argv, so it stays off the process list. Every variable Leo can also read from
  a `.env` file is assigned an explicit value rather than deleted — `DEVNET` above
  all, since `--devnet` has no negative form and a `DEVNET=true` left on disk
  would otherwise win. Transactions are saved to a `0o700` temporary directory
  outside `artifacts/`, removed in a `finally`.
  
  **`@lionden/core`** gains `redactSecrets` and `createStreamRedactor`, plus the
  existing `parseLeoVersionOutput` is now exported. Every byte of Leo's output
  that reaches the user — forwarded stdout, the buffered tail, and the tail
  embedded in error messages — passes through the stream redactor first. It is a
  small state machine rather than a windowed regex because a private key split
  across chunk boundaries matches no per-chunk pattern, and the key grammar has no
  upper bound, so no fixed carry-over window is provably safe. Leo's own truncated
  rendering — `APrivateKey1zkp8CZNn3yeC...`, the first 24 characters of the signing
  key, printed in its deployment plan summary — is redacted too; it is 12
  characters of real key material and is far too short to trip the length-based
  rule, so the trailing ellipsis is what identifies it.

### Patch Changes

- Updated dependencies [[`360ed41`](https://github.com/sealance-io/lionden/commit/360ed413d9d0640cbd02cca8135d43d6e651ad9b), [`5ec7f5f`](https://github.com/sealance-io/lionden/commit/5ec7f5f127b6bcac7a3eafdfc935eda00efa54f7)]:
  - @lionden/config@0.2.0

## 0.1.1

### Patch Changes

- [#76](https://github.com/sealance-io/lionden/pull/76) [`b4a8b28`](https://github.com/sealance-io/lionden/commit/b4a8b28a9ba7d35b1d238313028af5c83321228c) Thanks [@fullkomnun](https://github.com/fullkomnun)! - First release through the automated OIDC trusted-publishing pipeline; ships provenance
  attestations. No functional changes.
- Updated dependencies [[`b4a8b28`](https://github.com/sealance-io/lionden/commit/b4a8b28a9ba7d35b1d238313028af5c83321228c)]:
  - @lionden/config@0.1.1
