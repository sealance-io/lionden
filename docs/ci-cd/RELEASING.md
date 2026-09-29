# Releasing

When to read this: use [§1](#1-add-a-changeset-with-your-pr) when adding a changeset (the common
contributor task) and [Recovery](#recovery) when a release failed or is incomplete. The rest
documents the automated versioning and publishing pipeline and its
[CI release guards](#ci-release-guards); skip it unless you are changing release automation.

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

After adding or editing a changeset, run `npm run check:release-plan` before committing. CI runs
the same check on every PR (see [CI release guards](#ci-release-guards)).

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

Review this PR like any other — it is the human checkpoint for what's about to ship. CI checks
the mechanical part; see [CI release guards](#ci-release-guards).

`npm run test:version-packages` exercises release-plan assembly, application, changelogs, and
lockfile regeneration in disposable local workspaces after dependency installation. CI runs it
alongside the existing zero-dependency release-policy checks.

### CI release guards

**Version-edit guard.** Public package versions change only through the Version Packages PR. On
every other PR, CI runs `npm run check:version-edits -- --base <merge-base> --head <head>`
(zero-dependency, before `npm ci`) and fails if any public manifest version differs from the PR's
merge base. The exception is decided from the event, not the branch name alone: the head must be
`changeset-release/main` in this repository, targeting `main`. A fork reusing the branch name is
a regular PR. `release-publish.yml` applies the same identity checks before publishing and
additionally requires the merged PR's merge commit to be the pushed commit.

**Release-plan check.** `npm run check:release-plan` (`scripts/version-packages.mjs --check`)
runs the same planning and policy validation against the repository's real pending changesets and
stops before writing any file. CI runs it on every PR, so a changeset that would not converge all
11 public packages, or that targets a private or example workspace, fails before it reaches
`main`. With no pending changesets and aligned manifests (ordinary PRs, the Version Packages PR)
the check passes. It does not reject major bumps: from aligned `0.x` packages a `major` changeset
legitimately plans `1.0.0` for the whole group, and that remains a review decision.

**Release-state validation.** On the Version Packages PR, CI runs
`npm run validate:release-state -- --base origin/main`: all 11 public manifests share one
version, no unreleased changesets remain, and that version is exactly what `main`'s pending
changesets plan, so hand-substituted versions cannot pass. The lockfile guard covers
manifest/lockfile agreement. The same validation runs again in `release-publish.yml` immediately
before `changeset publish`, against `main`'s tip before the merge push (`github.event.before`),
which holds under merge-commit, squash, and multi-commit rebase merges.

**No prerelease mode.** Prerelease mode is not part of the release policy. Every planner entry
point (versioning, `--check`, release-state validation, and exported base plans) rejects a present
`.changeset/pre.json`, tracked or not, regardless of its contents, including `mode: "exit"`.
Adopting prerelease mode requires an explicit policy change to `scripts/release-plan.mjs`, not a
`changeset pre` invocation.

### Recovery from the partial 0.2 publication (historical)

The partial 0.2 publication left the public manifests skewed. The release policy permits exactly
one recovery from that state, and it stays encoded as a dormant guard in the shared planner that
versioning, `--check`, and release-state validation use:

- **Allowed starting map** (`COORDINATED_RECOVERY_START_VERSIONS` in
  `scripts/release-policy.mjs`): `0.2.0` for `@lionden/config`, `@lionden/core`,
  `@lionden/leo-compiler`, `@lionden/network`, and `@lionden/plugin-deploy`; `0.1.2` for
  `@lionden/cli`, `@lionden/plugin-leo`, `@lionden/plugin-network`, `@lionden/plugin-test`, and
  `@lionden/testing`; `0.1.1` for `create-lionden`.
- **Required convergence target:** `0.3.0` (`RECOVERY_TARGET_VERSION` in
  `scripts/release-plan.mjs`).

From that exact map, versioning keeps the fixed group active, so the pending changesets bump every
public package from the group's highest current version (0.2.0), and the plan must converge at
0.3.0 before any files are written. That gives every package a new version without overwriting
any published 0.2.0 package; at the time, the recovery release also carried the then-pending
dynamic-record compiler changes. The committed `.changeset/config.json` is never modified.

Public-version skew is not an accepted state. While the manifests are aligned, every run applies
the fixed group normally. Any skew that does not match the starting map exactly makes versioning
fail, and a matching skew may only converge at 0.3.0.

## 3. Publishing (automatic, gated)

Merging the "Version Packages" PR triggers **`release-publish.yml`**:

1. `check-release` confirms the push is the merged `changeset-release/main` PR.
2. The `publish-npm` job (behind the protected **`npm-publish`** environment — a maintainer must
   approve) builds, then runs `changeset publish` to publish every bumped package to npm via
   **OIDC trusted publishing** (no tokens). Publishing is idempotent: already-published versions
   are skipped.
3. The workflow checks all 11 current package versions concurrently, retrying with bounded
   exponential backoff within one shared five-minute deadline for them to appear in npm's
   packuments, with a 15-second timeout on each registry request. Persistent registry failures
   fail the protected release job; if every version did reach npm, repair the missing tags and
   Releases as described in [Recovery](#recovery) instead of rerunning publication. The workflow
   reads only those current versions' immutable `gitHead` values, validates existing refs from
   one remote-tag snapshot, pushes missing refs as one batch, and verifies the batch with a second
   snapshot. Historical npm versions are deliberately outside the critical release path: automatic
   and metadata-only runs both ignore them, which avoids granting the release App permission to
   write workflow files merely to create a tag at a historical commit whose workflow tree differs
   from `main`.
4. Existing GitHub Releases are listed in pages and left unchanged. Missing Releases are created
   without generated notes; release creation does not depend on a non-semver tag order or an
   inferred previous tag.

## Prerequisites & gotchas

- **The first release was special (done).** The very first publish (0.1.0, 2026-07-22) was a
  one-time manual, token-authenticated step, followed by Trusted Publisher configuration. The
  0.1.1 release proved the tokenless OIDC pipeline end-to-end. Adding a public package requires
  an explicit release-policy decision. npm's documented trusted-publisher setup requires the
  package to exist on the registry first; re-verify that constraint when designing the
  bootstrap. The historical bootstrap procedure is not authorization to publish locally. See
  [REPOSITORY-SETUP.md → One-time bootstrap](./REPOSITORY-SETUP.md#one-time-bootstrap-required-before-oidc-works)
  for that historical record.
- **Provenance** follows repository visibility: `release-publish.yml` enables it only when the
  repo is public (see [REPOSITORY-SETUP.md → Provenance](./REPOSITORY-SETUP.md#provenance)).
  The 0.1.1 release was the first to ship SLSA provenance attestations, and every release
  published while the repo is public carries them; verify with `npm audit signatures`.
- **Approval required.** Every publish waits on the `npm-publish` environment reviewers.
- **The workflow is the only sanctioned publisher.** There is no root `release` script;
  `release-publish.yml` runs `npx changeset publish` itself. Every package's npm publishing
  access is set to require 2FA and disallow tokens, so a stored or leaked token cannot publish.
  A maintainer can still publish interactively with 2FA; do not. See
  [REPOSITORY-SETUP.md → Publishing access](./REPOSITORY-SETUP.md#publishing-access-per-package-11).
- **Manual dispatches repair metadata without publishing.** A manual `release-publish.yml`
  dispatch from `main` skips dependency installation, build, and `changeset publish` entirely.
  It recovers the checked-out versions' source commits from npm `gitHead`, pushes missing tags,
  verifies them, and creates missing GitHub Releases. This is safe even before a pending Version
  Packages PR merges because the checked-out manifests can never be published by that path.
- **A successful npm step is not enough.** The publish job fails unless every published package
  version checked out by the run has a tag that resolves remotely to the same commit npm records
  and a matching GitHub Release.

## Recovery

Two failure shapes, two different actions. Decide by comparing npm with the release commit's
manifests before doing anything.

1. **Some package versions are missing from npm** (the publish job failed part-way, or the
   registry rejected some packages), **and that release is still the intended one**: no newer
   version has been published since, and its source needs no correction. **Re-run the failed
   `publish-npm` job from the original release run** (Actions → that run → *Re-run failed jobs*).
   The rerun keeps the original commit and event, so the release gate still recognises the merged
   Version Packages PR; it remains subject to the `npm-publish` environment's current protection
   rules, so approve the pending deployment if requested. `changeset publish` skips versions
   already on npm and publishes the rest, then tag reconciliation runs as usual.
   Never re-run a superseded release: `changeset publish` tags every package it publishes as
   `latest`, so completing an old partial release after a newer one shipped would move those
   packages' `latest` backwards. Leave the abandoned version incomplete.
2. **Every package version is on npm, but tags or GitHub Releases are missing.** Use the
   **metadata-only manual dispatch** described above. Do not re-run the publish job for this;
   nothing is left to publish, and the rule against re-running publication exists precisely to
   keep metadata repair from touching npm.

What a rerun can and cannot pick up. A rerun retains the original SHA and event payload, so
anything committed to the repository (workflow files, release scripts, manifests) is frozen at
that commit: it does not see fixes merged later, and it cannot publish versions that were not in
that commit's manifests. Re-running an older release run therefore never picks up a later fix
(historically, re-running the 0.2 release run could not perform the 0.3.0 recovery). Live
configuration is different: GitHub rulesets, environment protection, the App's permissions, and
npm publishing access are read at run time, so correcting one of those can let the original run
succeed on rerun without another version bump. If the fix is in source (a broken
workflow step, a validation the release commit cannot pass), land it on `main`, add the changesets
the release needs, and go through a new Version Packages PR. That path publishes a new
coordinated version and leaves the abandoned version incomplete on npm, which is acceptable. The
release-state validation that runs immediately before publishing has the same property: a commit
it rejects stays unpublished, and the way forward is a corrected commit, not a rerun.

## Consuming lionden

Depend on every `@lionden/*` package with one coordinated caret range: the `^<version>` of a
single LionDen release, which is what `create-lionden` generates for a new project (see
[§1](#1-add-a-changeset-with-your-pr)). Pre-1.0 caret ranges don't cross minor versions, so move
every `@lionden/*` range together when upgrading. Consumers must depend on registry versions,
never on `file:` paths into a lionden checkout — `file:` deps bypass the published artifacts and
break as soon as the checkout moves.

For the underlying repository/account configuration (environments, GitHub App, npm trusted
publishers), see [REPOSITORY-SETUP.md](./REPOSITORY-SETUP.md).
