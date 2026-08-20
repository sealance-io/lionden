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

### Patch Changes

- Updated dependencies [[`360ed41`](https://github.com/sealance-io/lionden/commit/360ed413d9d0640cbd02cca8135d43d6e651ad9b), [`5ec7f5f`](https://github.com/sealance-io/lionden/commit/5ec7f5f127b6bcac7a3eafdfc935eda00efa54f7)]:
  - @lionden/config@0.2.0
  - @lionden/core@0.2.0

## 0.1.1

### Patch Changes

- [#76](https://github.com/sealance-io/lionden/pull/76) [`b4a8b28`](https://github.com/sealance-io/lionden/commit/b4a8b28a9ba7d35b1d238313028af5c83321228c) Thanks [@fullkomnun](https://github.com/fullkomnun)! - First release through the automated OIDC trusted-publishing pipeline; ships provenance
  attestations. No functional changes.
- Updated dependencies [[`b4a8b28`](https://github.com/sealance-io/lionden/commit/b4a8b28a9ba7d35b1d238313028af5c83321228c)]:
  - @lionden/config@0.1.1
  - @lionden/core@0.1.1
