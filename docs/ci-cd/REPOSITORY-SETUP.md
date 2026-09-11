# Repository settings for CI/CD & releases

This is the one-time GitHub/npm configuration the workflows in `.github/workflows/` depend on.
Workflows are version-controlled; these settings are not, so they live here.

> Status note: the repo is **public** (since 2026-07-22). The visibility-gated security checks
> (see [Dependency review & code scanning](#dependency-review--code-scanning)) and npm
> provenance are active.

## Workflows at a glance

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | PRs to `main` | dependency-review (gated), lockfile validation (registry-only, integrity, and workspace-manifest synchronization), release-script regression tests, build, unit+contract tests, lint/format (Biome `check:ci`), smoke (Leo devnode, core examples). Rollup: **CI Status**. |
| `security-audit.yml` | PR/push/weekly | zizmor workflow audit. Rollup: **Security Audit Status**. |
| `pinact-verify.yml` | PR/push | Action SHA-pin + cooldown verification. Rollup: **pinact Status**. |
| `release-version.yml` | push to `main` | Opens/updates the "Version Packages" PR (changesets + GitHub App token). |
| `release-publish.yml` | push to `main` + manual | A Version Packages PR merge publishes bumped packages via OIDC; a manual run is metadata-only. Both reconcile all published tags from npm `gitHead` and create/verify GitHub Releases. |
| `leo-cache-warmup.yml` | weekly (Sat 23:00 UTC) + manual | Pre-builds & caches the Leo 4.3.2 CLI so the `smoke` lane hits a warm cache. |

> **`sealance-io/setup-leo-action` pin + intentional Leo-version split.** All four call sites
> pin the released **v1.1.3** (`3fb8fc821388716961eee9146b414fcfc093b32d`), which builds Leo
> from source and resolves the requested `leo-lang-v<version>` tag. As a first-party
> (`sealance-io`) artifact it is exempt from the action cooldown via the
> `ActionRepoOwner == "sealance-io"` → `min_age: 0` rule in `.pinact.yaml` (no per-action
> `ignore` needed; `pinact --verify` resolves the released tag). The `version:` values are
> **intentionally split**, not moved together:
> - **`smoke` (`ci.yml`) + `leo-cache-warmup.yml`** request Leo **`4.3.2`** — the default line,
>   matching the core + aleo-ports examples' `leoVersion`.
> - **`leo-samples` (`ci.yml`) + `leo-samples-nightly.yml`** stay pinned to Leo **`4.2.0`** /
>   consensus V15 — the leo-samples fixture set is decoupled from the 4.3.x bump (see
>   [`../leo-version-compatibility.md`](../leo-version-compatibility.md)).
>
> Both lines share `rust-version: "1.96.0"` (Leo 4.3.2 MSRV == 4.2.0). When bumping either line,
> update that lane's `version:` (and `rust-version:` if the MSRV changes) and re-pin every
> affected `uses:` line to a `setup-leo-action` release that installs that Leo version.

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

## Branch ruleset on `changeset-release/*`

The Version Packages PR is the only PR allowed to change public package versions, and CI
identifies it by head repository, branch, and base (see `docs/ci-cd/RELEASING.md`). That check
establishes *which* PR it is, not *who* wrote its contents. A second ruleset makes the release
App the only actor that can write the branch, so a human cannot push edits into an open Version
Packages PR that would then ship on merge.

Create a ruleset targeting the branch pattern `changeset-release/*`:

- **Enforcement status: Active.** The creation form defaults to *Disabled*; a disabled ruleset
  is saved but enforces nothing.
- **Restrict creations** and **restrict updates**. Deletions are deliberately left open:
  deleting cannot inject content (creation stays restricted); the worst case is a closed PR,
  after which the action recreates the branch and opens a replacement PR on its next run while
  changesets remain (interrupting review and requiring fresh approvals); and it lets GitHub's
  automatic head-branch deletion and manual cleanup work without the App.
- **Bypass list:** the release GitHub App (the one behind `SEALANCE_PUBLIC_SIGNER_APP_ID`),
  mode **Always**. Add nothing else — not the repository admin role, not any team.
- **Block force-pushes** and **require linear history** are not needed. The pinned
  `changesets/action` updates the branch with a forced ref update on every run to refresh the
  PR. Adding those rules to *this* ruleset would still work, because the App's **Always** bypass
  covers every rule in the ruleset. Do not add them through a *separate* ruleset that also
  matches `changeset-release/*` without the same bypass: rulesets layer, and the most
  restrictive applicable rule wins.

Merging the PR touches `main`, not this branch, so the `main` ruleset still governs the merge.

What this costs: nobody can hand-fix an open Version Packages PR (fix the changeset on `main`
instead and let the action regenerate it), and the PR's **Update branch** button is rejected (the
action rebases the branch on every push to `main` anyway). The escape hatch for anything else is
an admin setting the ruleset to *Disabled*, acting, and re-enabling it — an audited, deliberate
step rather than a routine capability.

**Verification.** The App path verifies itself: the next push to `main` with pending changesets
runs `release-version.yml`, which must create or force-push `changeset-release/main`. If the
bypass is wrong, that run fails visibly at the push with nothing lost; fix the ruleset and
dispatch the workflow again. The ruleset's **Insights** view then shows the App as a bypass actor.

Probing the human path is optional; the ruleset page showing *Active*, both restrictions, and only
the App in the bypass list is the configuration evidence. To prove it end to end once, push a
fast-forward built from the fetched release tip without touching `HEAD` or the index, so a
rejection can only be the server's. Both pushes must fail with a ruleset violation (`GH013`);
rulesets apply to admins unless the admin role is in the bypass list:

```bash
git fetch origin changeset-release/main
tip=$(git rev-parse origin/changeset-release/main)
probe=$(git commit-tree "$tip^{tree}" -p "$tip" -m probe)
git push origin "$tip:refs/heads/changeset-release/probe"     # creation (name must not exist)
git push origin "$probe:refs/heads/changeset-release/main"    # update
```

If a push unexpectedly succeeds, the ruleset is not enforcing: fix it, then delete
`changeset-release/probe` (deletions are unrestricted). A successful update push adds one empty
commit to the release PR that the action's next run replaces.

## Environments

Create two environments (Settings → Environments):

- **`npm-publish`** — used by `release-publish.yml`. Add **required reviewers** (maintainers)
  so every npm publish is a deliberate, approved action. Restrict deployment branches to
  `main` only.
- **`release-automation`** — used by `release-version.yml`. No reviewers needed; restrict
  deployment branches to exactly `main` (selected branches, one entry, no wildcard). The
  workflow's `version` job also carries a job-level `if: github.ref == 'refs/heads/main'`
  guard, evaluated before the environment gate and before any App token is minted, so the two
  layers are independent. Verify them separately: the environment's exact-`main` restriction is
  confirmed in the environment's settings page, since a skipped job never reaches it. The
  workflow guard is confirmed by dispatching `release-version.yml` from a non-`main` branch
  that contains this guard (an older branch runs its older workflow) and checking that the
  `version` job is skipped, then by a `main` run with pending changesets reaching the
  versioning step.

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

The publish workflow's manual dispatch is also the recovery path for a release that reached npm
without tags or GitHub Releases. It is safe to approve on `main` even while a Version Packages PR
is pending: the manual path skips dependency installation, build, and `changeset publish`, so it
cannot publish the checked-out manifests. Historical and current missing tags are recreated only
at npm's recorded `gitHead`, remote targets are verified, and existing Releases are left
unchanged. Automatic runs retry npm packument reads after publishing so ordinary registry
replication lag does not immediately fail metadata reconciliation. Remote tags are fetched once
in the steady state, and GitHub Releases are listed in pages before only the missing ones are
created.

## npm publishing (OIDC trusted publishing)

Publishing is **tokenless** in steady state: `release-publish.yml` requests `id-token: write`
and npm exchanges the GitHub OIDC token for a short-lived publish credential. No npm automation
token is stored in GitHub.

### One-time bootstrap (required before OIDC works)

> **Status: completed 2026-07-22.** All 11 packages were published manually at 0.1.0, Trusted
> Publishers were configured per the steps below (verified with `npm trust list`), and the
> 0.1.1 release ran tokenless through `release-publish.yml` with provenance attestations on
> every package. The steps are kept for reference (e.g. adding a brand-new package later, which
> repeats this bootstrap for that package).

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

### Publishing access per package (×11)

For each of the same 11 packages, under **Settings → Publishing access** on npmjs.com, select
**Require two-factor authentication and disallow tokens**. OIDC trusted publishing keeps working
under this setting, and it removes the traditional path where anyone holding an npm token could
publish from a laptop, bypassing every gate in this repository.

Verify, for each package, that the Trusted Publisher still points at exactly:

- repository `sealance-io/lionden`
- workflow filename `release-publish.yml`
- environment `npm-publish`

What this does **not** do: it does not make CI the only publisher. A maintainer with publish
rights can still run `npm publish` interactively after completing 2FA. That residual access is a
people-and-permissions matter (keep the npm org's maintainer list minimal), not something this
repository can enforce. There is no root `npm run release` shortcut; `release-publish.yml` calls
`npx changeset publish` directly, and nothing else in the repo publishes.

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
