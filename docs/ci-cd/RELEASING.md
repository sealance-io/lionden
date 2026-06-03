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

Pick the affected packages and a bump level for each:

- **patch** — bug fixes, internal changes
- **minor** — backwards-compatible features
- **major** — breaking changes (we are pre-1.0, so treat breaking changes deliberately)

Write a short, user-facing summary. Commit the generated `.changeset/*.md` file with your PR.
A PR with no changeset publishes nothing — that's fine for docs/CI-only changes.

Packages version **independently** (no `fixed`/`linked` groups). When you bump a package, any
in-repo dependents whose range no longer matches are bumped a patch automatically
(`updateInternalDependencies: "patch"`), and their internal `^x.y.z` ranges are rewritten.

## 2. Versioning (automatic)

On merge to `main`, **`release-version.yml`** consumes the pending changesets and opens (or
updates) a **"Version Packages"** PR that:

- bumps each affected package's `version`,
- rewrites internal dependency ranges,
- writes per-package `CHANGELOG.md` entries (via `@changesets/changelog-github`),
- deletes the consumed changeset files.

Review this PR like any other — it is the human checkpoint for what's about to ship.

## 3. Publishing (automatic, gated)

Merging the "Version Packages" PR triggers **`release-publish.yml`**:

1. `check-release` confirms the push is the merged `changeset-release/main` PR.
2. The `publish-npm` job (behind the protected **`npm-publish`** environment — a maintainer must
   approve) builds, then runs `changeset publish` to publish every bumped package to npm via
   **OIDC trusted publishing** (no tokens). Publishing is idempotent: already-published versions
   are skipped.
3. Git tags created by `changeset publish` are pushed, and a GitHub Release is created per new
   tag.

## Prerequisites & gotchas

- **First release is special.** OIDC publishing cannot create brand-new packages, so the very
  first publish is a one-time manual, token-authenticated step. See
  [REPOSITORY-SETUP.md → One-time bootstrap](./REPOSITORY-SETUP.md#one-time-bootstrap-required-before-oidc-works).
- **Provenance** is enabled automatically once the repo is public; it stays off while internal.
- **Approval required.** Every publish waits on the `npm-publish` environment reviewers.
- **Re-runs are safe.** `changeset publish` and the GitHub Release step are idempotent.

For the underlying repository/account configuration (environments, GitHub App, npm trusted
publishers), see [REPOSITORY-SETUP.md](./REPOSITORY-SETUP.md).
