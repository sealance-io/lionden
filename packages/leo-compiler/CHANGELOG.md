# @lionden/leo-compiler

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

- [#93](https://github.com/sealance-io/lionden/pull/93) [`0e21308`](https://github.com/sealance-io/lionden/commit/0e21308ff9f36d5eaf769a57edf7b432e72011d9) Thanks [@fullkomnun](https://github.com/fullkomnun)! - Extend the **Leo CLI deploy backend** to `upgrade` and to HTTP networks, and stop
  writing real private keys into materialized Leo packages.
  
  **`upgrade` on the Leo backend.** `leo upgrade` takes the same flag surface as
  `leo deploy` — down to `--skip`, whose help text differs only in the verb — so
  both operations run the same invocation path: `--save` without `--broadcast`,
  lionden broadcasts, and the pending marker, edition bookkeeping, confirmation
  polling and `programUpgraded` hook all stay where they are. Leo derives the new
  edition itself; there is no `--edition` flag and nothing about lionden's
  `previousEdition` bookkeeping changes.
  
  `upgradeAction` now resolves the program's **local dependency closure**, which
  it previously had no reason to compute. `leo upgrade` upgrades a package's whole
  local closure by default, so every dependency has to be named in `--skip` for
  lionden to keep owning one program per invocation. The traversal roots at the
  **source** program id and subtracts the **source** id — not the effective
  post-rename one. Subtracting the effective id would be a no-op, because the
  post-rename id is not a node in the source graph, and would leave the source id
  in the skip list; since Leo matches skips by substring, `--skip hello.aleo` also
  suppresses `renamed_hello.aleo`, so the run would exit 0 having upgraded
  nothing.
  
  **HTTP networks.** Both operations, and `--dry-run`, now work against a real
  network. The Leo backend can dry-run where the SDK cannot: `--save` without
  `--broadcast` builds a transaction and hands it back, while the SDK's HTTP path
  builds and broadcasts as one atomic operation. Two devnode-only flags are
  omitted on HTTP — `--devnet`, and `--skip-deploy-certificate`, which substitutes
  placeholder certificates and verifying keys that a real network rejects.
  
  **Security: no private key on disk for HTTP networks.**
  `materializePackage` wrote `PRIVATE_KEY=<the network's real key>` into
  `<artifacts>/.build/<id>/.env`. That is a live credential at rest inside the
  build output — routinely archived, copied into containers and shared — and
  nothing needs it there: `leo build` signs nothing, and the deploy backend
  supplies a key through the child environment. The line is now omitted entirely
  for `type: "http"` networks, including the devnode placeholder that a keyless
  HTTP network used to get. The placeholder stays for devnode networks; it is the
  well-known key Leo publishes in its own `--help`.
  
  **Security: Leo is never left to pick the signing identity.** Leo resolves
  `PRIVATE_KEY` from a `.env` file in its working directory and every parent of
  it — the project root, not the materialized package, which it does not consult
  for this. So clearing the variable from the child environment is not "no key",
  it is "whatever key is on disk", and a deployment signed by an identity lionden
  never selected succeeds under the wrong account. The Leo backend now refuses to
  spawn at all when neither `networks.<n>.privateKey` nor a `deployer`/`admin`
  named account supplies one, naming both in the error.
  
  `DEVNET` is pinned to a literal `true`/`false` for the same reason. A project
  `.env` carrying `DEVNET=true` from local devnode work would otherwise win on an
  unset variable and send a real-network deployment out in devnet mode; `--devnet`
  is a valueless flag with no negative form, so an explicit `DEVNET=false` is the
  only way to force it off. `NETWORK` and `ENDPOINT` are pinned likewise.
  
  **`--dry-run` no longer claims to be devnode-only.** The rejection named a
  connection type, which was accurate only while the Leo backend was devnode-only.
  It now names the backend that cannot build without broadcasting and points at
  `--deploy-backend leo`, which can, on any network. The `deploy --dryRun` help
  text says the same.

### Patch Changes

- Updated dependencies [[`360ed41`](https://github.com/sealance-io/lionden/commit/360ed413d9d0640cbd02cca8135d43d6e651ad9b), [`5ec7f5f`](https://github.com/sealance-io/lionden/commit/5ec7f5f127b6bcac7a3eafdfc935eda00efa54f7), [`80f7f5f`](https://github.com/sealance-io/lionden/commit/80f7f5fabdcff36e054648a1fb1aab0a9b647642)]:
  - @lionden/config@0.2.0
  - @lionden/core@0.2.0

## 0.1.1

### Patch Changes

- [#76](https://github.com/sealance-io/lionden/pull/76) [`b4a8b28`](https://github.com/sealance-io/lionden/commit/b4a8b28a9ba7d35b1d238313028af5c83321228c) Thanks [@fullkomnun](https://github.com/fullkomnun)! - First release through the automated OIDC trusted-publishing pipeline; ships provenance
  attestations. No functional changes.
- Updated dependencies [[`b4a8b28`](https://github.com/sealance-io/lionden/commit/b4a8b28a9ba7d35b1d238313028af5c83321228c)]:
  - @lionden/config@0.1.1
  - @lionden/core@0.1.1
