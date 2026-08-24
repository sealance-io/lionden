# Releasing

`lionden` publishes 11 packages from one monorepo using [Changesets](https://github.com/changesets/changesets).
Versioning and publishing are automated; you only ever write a changeset.

> Published packages: `@lionden/config`, `@lionden/core`, `@lionden/leo-compiler`,
> `@lionden/network`, `@lionden/testing`, `@lionden/plugin-leo`, `@lionden/plugin-network`,
> `@lionden/plugin-deploy`, `@lionden/plugin-test`, `@lionden/cli`, and `create-lionden`.
> `@lionden/test-internals` is private and never published.

## 1. Add a changeset with your PR

When your change should ship, run:

```bash
npm run changeset
```

Pick the packages whose changes need changelog entries and a bump level for each:

- **patch** — bug fixes, internal changes
- **minor** — backwards-compatible features
- **major** — breaking changes (we are pre-1.0, so treat breaking changes deliberately)

Write a short, user-facing summary. Commit the generated `.changeset/*.md` file with your PR.
A PR with no changeset publishes nothing — that's fine for docs/CI-only changes.

All 11 public packages are one **fixed release group**. The highest requested bump in any
changeset applies to every public package, so each published LionDen toolchain release has one
version. `@lionden/test-internals` remains private and outside the group. Do not hand-edit package
versions or remove a package from the fixed group to make a one-off release.

`create-lionden` derives its generated `@lionden/*` ranges from its own package version. Because
the scaffolder is in the fixed group, a `create-lionden@x.y.z` release always emits `^x.y.z` for
the whole toolchain instead of mixing incompatible pre-1.0 lines.

## 2. Versioning (automatic)

On merge to `main`, **`release-version.yml`** consumes the pending changesets and opens (or
updates) a **"Version Packages"** PR that:

- bumps all 11 public package versions by the fixed group's highest requested release type,
- rewrites internal dependency ranges,
- verifies that all 11 public package versions converged,
- regenerates `package-lock.json` with lifecycle scripts disabled and validates every workspace
  version and dependency range against its manifest,
- writes per-package `CHANGELOG.md` entries (via `@changesets/changelog-github`),
- deletes the consumed changeset files.

Review this PR like any other — it is the human checkpoint for what's about to ship. Do not merge
it unless all 11 public manifests have the same version and the lockfile contains that version.

The coordinated 0.2 release starts from a one-time historical skew. `scripts/version-packages.mjs`
temporarily applies the pending six-package alignment changeset without the fixed constraint,
requires all 11 packages to converge at 0.2.0, then restores the committed fixed policy. Once
aligned, every later run applies the fixed group normally; a future skew makes versioning fail.

## 3. Publishing (automatic, gated)

Merging the "Version Packages" PR triggers **`release-publish.yml`**:

1. `check-release` confirms the push is the merged `changeset-release/main` PR.
2. The `publish-npm` job (behind the protected **`npm-publish`** environment — a maintainer must
   approve) builds, then runs `changeset publish` to publish every bumped package to npm via
   **OIDC trusted publishing** (no tokens). Publishing is idempotent: already-published versions
   are skipped.
3. The workflow enumerates every npm-published version of all 11 packages, reads each immutable
   `gitHead`, creates any missing local tag at that exact commit, pushes it, and verifies the
   remote ref. This includes historical versions, so a late rerun still repairs older omissions.
4. A GitHub Release is created or verified for every reconciled tag.

## Prerequisites & gotchas

- **The first release was special (done).** OIDC publishing cannot create brand-new packages,
  so the very first publish (0.1.0, 2026-07-22) was a one-time manual, token-authenticated
  step, followed by Trusted Publisher configuration. The 0.1.1 release proved the tokenless
  OIDC pipeline end-to-end. See
  [REPOSITORY-SETUP.md → One-time bootstrap](./REPOSITORY-SETUP.md#one-time-bootstrap-required-before-oidc-works).
- **Provenance** is active (the repo is public): every release since 0.1.1 ships SLSA
  provenance attestations, verifiable with `npm audit signatures`.
- **Approval required.** Every publish waits on the `npm-publish` environment reviewers.
- **Re-runs repair metadata.** npm versions are immutable, so `changeset publish` skips versions
  that already exist. The following reconciliation does not depend on Changesets recreating a
  local tag: it recovers the source commit from npm `gitHead`, pushes a missing tag, verifies it,
  and creates a missing GitHub Release. Use a manual `release-publish.yml` dispatch from `main`
  for tag/Release backfills; do not increment or republish packages just to repair metadata.
- **A successful npm step is not enough.** The publish job fails unless every published package
  tag resolves remotely to the same commit npm records and every matching GitHub Release exists.

## Consuming lionden

Consumers must depend on one coordinated registry line (e.g. `"@lionden/cli": "^0.2.0"`), never
on `file:` paths into a lionden checkout — `file:` deps bypass the published artifacts and break
as soon as the checkout moves. `compliant-transfer-aleo` migrated to registry ranges with the
0.1.0 release; migrating `amm-aleo` is a deferred follow-up.

For the underlying repository/account configuration (environments, GitHub App, npm trusted
publishers), see [REPOSITORY-SETUP.md](./REPOSITORY-SETUP.md).
