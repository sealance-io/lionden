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

Recovery from the partial 0.2 publication starts from one exact, hard-coded historical version
map. `scripts/version-packages.mjs` validates that map and keeps the fixed group active, so the
pending changesets bump every public package from the group's highest current version (0.2.0).
The recovery must converge at 0.3.0 before any files are written. This includes the pending
dynamic-record compiler changes and gives every package a new version without overwriting any
published 0.2.0 package. The committed `.changeset/config.json` is never modified. Once aligned,
every later run applies the fixed group normally; any other skew makes versioning fail.

`npm run test:version-packages` exercises release-plan assembly, application, changelogs, and
lockfile regeneration in disposable local workspaces after dependency installation. CI runs it
alongside the existing zero-dependency release-policy checks.

`npm run check:release-plan` (`scripts/version-packages.mjs --check`) runs the same planning and
policy validation against the repository's real pending changesets and stops before writing any
file. CI runs it on every PR, so a changeset that would not converge all 11 public packages, or
that targets a private or example workspace, fails before it reaches `main`. With no pending
changesets and aligned manifests (ordinary PRs, the Version Packages PR) the check passes. It does
not reject major bumps: from aligned `0.x` packages a `major` changeset legitimately plans `1.0.0`
for the whole group, and that remains a review decision.

## 3. Publishing (automatic, gated)

Merging the "Version Packages" PR triggers **`release-publish.yml`**:

1. `check-release` confirms the push is the merged `changeset-release/main` PR.
2. The `publish-npm` job (behind the protected **`npm-publish`** environment — a maintainer must
   approve) builds, then runs `changeset publish` to publish every bumped package to npm via
   **OIDC trusted publishing** (no tokens). Publishing is idempotent: already-published versions
   are skipped.
3. The workflow waits for each checked-out package version to appear in npm's packument, then
   enumerates every npm-published version of all 11 packages and reads each immutable `gitHead`.
   One remote-tag snapshot validates existing refs; missing refs are pushed as one batch and a
   second snapshot verifies that batch. This includes historical versions, so a late rerun still
   repairs older omissions.
4. Existing GitHub Releases are listed in pages. Missing Releases are created without generated
   notes; release creation does not depend on a non-semver tag order or an inferred previous tag.

## Prerequisites & gotchas

- **The first release was special (done).** OIDC publishing cannot create brand-new packages,
  so the very first publish (0.1.0, 2026-07-22) was a one-time manual, token-authenticated
  step, followed by Trusted Publisher configuration. The 0.1.1 release proved the tokenless
  OIDC pipeline end-to-end. See
  [REPOSITORY-SETUP.md → One-time bootstrap](./REPOSITORY-SETUP.md#one-time-bootstrap-required-before-oidc-works).
- **Provenance** is active (the repo is public): every release since 0.1.1 ships SLSA
  provenance attestations, verifiable with `npm audit signatures`.
- **Approval required.** Every publish waits on the `npm-publish` environment reviewers.
- **Manual dispatches repair metadata without publishing.** A manual `release-publish.yml`
  dispatch from `main` skips dependency installation, build, and `changeset publish` entirely.
  It recovers source commits from npm `gitHead`, pushes missing tags, verifies them, and creates
  missing GitHub Releases. This is safe even before a pending Version Packages PR merges because
  the checked-out manifests can never be published by that path.
- **Registry replication is retried.** After an automatic publish, reconciliation waits with
  bounded exponential backoff until each checked-out package version is visible in its npm
  packument. Persistent registry failures still fail the protected release job.
- **Historical metadata exceptions are explicit.** A historical npm version with an invalid
  `gitHead`, or one with both a missing tag and a commit unavailable in the full checkout, fails
  reconciliation unless its exact tag and a non-empty reason are committed to
  `.changeset/release-tag-exceptions.json`. Exceptions cannot suppress the checked-out version,
  cannot excuse a remote-tag mismatch, and fail when unused so stale entries are removed.
- **A successful npm step is not enough.** The publish job fails unless every published package
  tag resolves remotely to the same commit npm records and every matching GitHub Release exists.

## Consuming lionden

After the recovery is published, consumers should use the coordinated `^0.3.0` registry line.
Consumers must depend on registry versions, never on `file:` paths into a lionden checkout —
`file:` deps bypass the published artifacts and break
as soon as the checkout moves. `compliant-transfer-aleo` migrated to registry ranges with the
0.1.0 release; migrating `amm-aleo` is a deferred follow-up.

For the underlying repository/account configuration (environments, GitHub App, npm trusted
publishers), see [REPOSITORY-SETUP.md](./REPOSITORY-SETUP.md).
