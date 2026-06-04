# Repository settings for CI/CD & releases

This is the one-time GitHub/npm configuration the workflows in `.github/workflows/` depend on.
Workflows are version-controlled; these settings are not, so they live here.

> Status note: the repo is **internal** today and OSS soon. A few security checks are
> visibility-gated and stay dormant until the repo is public (see
> [Dependency review & code scanning](#dependency-review--code-scanning)).

## Workflows at a glance

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | PRs to `main` | dependency-review (gated), lockfile validation (registry-only + integrity, via `npm run lint:lockfile`), build, unit+contract tests, lint/format (Biome `check:ci`), smoke (Leo devnode, core examples). Rollup: **CI Status**. |
| `security-audit.yml` | PR/push/weekly | zizmor workflow audit. Rollup: **Security Audit Status**. |
| `pinact-verify.yml` | PR/push | Action SHA-pin + cooldown verification. Rollup: **pinact Status**. |
| `release-version.yml` | push to `main` | Opens/updates the "Version Packages" PR (changesets + GitHub App token). |
| `release-publish.yml` | push to `main` | Publishes bumped packages to npm via OIDC; tags + GitHub Releases. |
| `leo-cache-warmup.yml` | weekly (Sat 23:00 UTC) + manual | Pre-builds & caches the Leo 4.1.0 CLI so the `smoke` lane hits a warm cache. |

> **Temporary pin — `sealance-io/setup-leo-action`.** Both the `smoke` lane (`ci.yml`) and
> `leo-cache-warmup.yml` request Leo `4.1.0`, which upstream tags `leo-lang-v4.1.0`. The
> released **v1.1.0** only resolves `v<version>` tags and cannot install 4.1.0, so both are
> pinned to the **head of [PR #19](https://github.com/sealance-io/setup-leo-action/pull/19)**
> (`1a751b6…`, unreleased) which adds source-tag support. As a first-party (`sealance-io`)
> artifact this is exempt from the cooldown — `.pinact.yaml` carries an `ignore` rule for it
> (an unreleased commit has no tag for `pinact --verify` to resolve). **When PR #19 ships:**
> re-pin both files to the released SHA + `# vX.Y.Z` comment and delete the `ignore` rule.
> Per that PR, Leo 4.1.0 pairs with `rust-version: "1.96.0"`.

## Branch ruleset on `main`

Create a ruleset (Settings → Rules → Rulesets) targeting `main`:

- **Require a pull request before merging**, with **required review from Code Owners** (see
  [`.github/CODEOWNERS`](../../.github/CODEOWNERS)) and dismiss stale approvals.
- **Require status checks to pass**, and add **only the rollup checks** — never the individual
  jobs, which legitimately skip and would otherwise hang as "Pending":
  - `CI Status`
  - `Security Audit Status`
  - `pinact Status`
- **Require linear history**; **block force-pushes**; **restrict deletions**.

The check names above are the rollup jobs' `name:` values. If you rename a rollup job, update
the ruleset to match.

## Environments

Create two environments (Settings → Environments):

- **`npm-publish`** — used by `release-publish.yml`. Add **required reviewers** (maintainers)
  so every npm publish is a deliberate, approved action. Restrict deployment branches to
  `main` only.
- **`release-automation`** — used by `release-version.yml`. No reviewers needed; restrict
  deployment branches to `main` only.

## GitHub App (release automation)

`release-version.yml` opens the "Version Packages" PR with a GitHub App token. This is required
because the default `GITHUB_TOKEN` cannot trigger downstream workflows — without it, merging the
version PR would never start `release-publish.yml`.

Reuse the existing Sealance org App (the same one `compliant-transfer-aleo` uses):

1. Install the App on the `lionden` repository with **Contents: read & write** and
   **Pull requests: read & write** permissions.
2. Set repository **variable** `SEALANCE_PUBLIC_SIGNER_APP_ID`.
3. Set repository **secret** `SEALANCE_PUBLIC_SIGNER_APP_PRIVATE_KEY` (the App's PEM private key).

Both `release-version.yml` and `release-publish.yml` mint a short-lived installation token
scoped to `lionden` via `actions/create-github-app-token`.

## npm publishing (OIDC trusted publishing)

Publishing is **tokenless** in steady state: `release-publish.yml` requests `id-token: write`
and npm exchanges the GitHub OIDC token for a short-lived publish credential. No npm automation
token is stored in GitHub.

### One-time bootstrap (required before OIDC works)

npm Trusted Publishers can only be attached to packages that **already exist** on the registry,
and OIDC cannot create a brand-new package. So the **first** publish of each package must be a
manual, token-authenticated step:

1. **Create/own the `@lionden` scope** on npmjs.com and reserve the unscoped `create-lionden`
   name.
2. From a maintainer machine, with a granular **automation token** in `NODE_AUTH_TOKEN`
   (satisfying 2FA/OTP if the org enforces it), build and publish all 11 packages at their
   initial version:
   ```bash
   npm install --ignore-scripts --allow-git=none
   npm run build
   # publishes every non-private workspace at its current version (idempotent)
   npm exec -- changeset publish
   ```
   (or `npm publish --workspace <pkg> --access public` for each, if you prefer per-package.)
3. Confirm they exist: `npm view @lionden/config version` should resolve (not 404).
4. Configure Trusted Publishers (below).
5. From then on, releases run tokenless via `release-publish.yml`.

### Trusted Publisher per package (×11)

On npmjs.com, for **each** of the 11 published packages — the 10 `@lionden/*` packages **and**
the unscoped `create-lionden` — add a Trusted Publisher:

- Provider: **GitHub Actions**
- Organization / repository: `sealance-io/lionden`
- Workflow filename: `release-publish.yml`
- Environment: `npm-publish`
- **Allowed actions: `npm publish`** (required for trusted-publisher configs created after
  2026-05-20 — select at least `npm publish`)

Packages: `@lionden/config`, `@lionden/core`, `@lionden/leo-compiler`, `@lionden/network`,
`@lionden/testing`, `@lionden/plugin-leo`, `@lionden/plugin-network`, `@lionden/plugin-deploy`,
`@lionden/plugin-test`, `@lionden/cli`, `create-lionden`.

> `@lionden/test-internals` is `private: true` and is never published — it has no Trusted
> Publisher and is excluded by `.changeset/config.json`.

### Provenance

`release-publish.yml` sets `NPM_CONFIG_PROVENANCE` from `repository.visibility`, so provenance
is **off while the repo is private** (npm cannot attest a private source repo) and **auto-enables
when the repo goes public**. All published manifests carry `repository` metadata pointing at
`sealance-io/lionden`, which npm requires for GitHub-based trusted publishing.

## Dependency review & code scanning

`actions/dependency-review-action` and zizmor's SARIF upload both require a **public repo** or
**GitHub Advanced Security** on a private repo. While internal they skip cleanly via the gate:

```
github.event.repository.visibility == 'public' || vars.SECURITY_CHECKS_ON_PRIVATE == 'true'
```

- Going public flips them on automatically.
- To run them earlier on the private repo, **enable GitHub Advanced Security** and set repository
  **variable** `SECURITY_CHECKS_ON_PRIVATE=true` (the override is needed because enabling GHAS
  does not change `repository.visibility`).

## Dependabot

[`.github/dependabot.yml`](../../.github/dependabot.yml) opens grouped npm (daily) and
github-actions (weekly) update PRs with a cooldown so freshly published versions age before
adoption. Action SHAs bumped by Dependabot keep their `# vX.Y.Z` comment; `pinact-verify.yml`
fails the PR if a pin or comment drifts or violates the cooldown.

The cooldown is **graded by the artifact's owner** — trust scales with the publisher, so it is
applied in both `.github/dependabot.yml` and [`.pinact.yaml`](../../.pinact.yaml):

| Owner | Cooldown |
| --- | --- |
| `sealance-io` (first-party) | none — adopt immediately |
| Provable / Aleo (`ProvableHQ`/`AleoHQ`, `@provablehq/*`) | minimal (≤3 days) |
| everyone else | standard (npm 7/4, actions 21 days) |

## CODEOWNERS

[`.github/CODEOWNERS`](../../.github/CODEOWNERS) assigns `@sealance-io/sealance-engineers` as the
default owner, with explicit ownership of `/.github/**` and `/.changeset/**`. Update the team
handle if ownership changes.
