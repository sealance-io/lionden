# AGENTS.md

This file is the navigation layer for agents working in the LionDen repo. Load the smallest amount of documentation necessary for the task.

## Start Here

1. Read [`README.md`](README.md) for the project overview and current status.
2. Read the relevant `docs/*.md` file for subsystem detail.
3. Open [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md) when you need design intent, roadmap context, or platform assumptions.

Do not load every doc up front. Most tasks only need one focused doc plus a few source files.

## Repo Snapshot

- `packages/config`: config types and helpers
- `packages/core`: plugin lifecycle, hooks, tasks, LRE
- `packages/cli`: CLI discovery, parsing, help, dispatch
- `packages/leo-compiler`: Leo source discovery, dependency resolution, materialization, compile pipeline, codegen
- `packages/network`: network manager, Aleo connection, devnode helpers, SDK adapter
- `packages/testing`: test LRE setup, devnode lifecycle, fixtures, assertions
- `packages/plugin-*`: default task plugins
- `packages/create-lionden`: project scaffolding
- `packages/test-internals`: repo-private test fakes, builders, and shared mocks
- `examples/`: concrete user-facing projects
- `examples/aleo-ports/`: ported compatibility examples and smoke-test configs
- `docs/`: focused deep dives for lazy loading

## Selective Disclosure Rules

- Prefer `README.md` plus one subsystem doc over broad doc loading.
- Prefer current code over plan docs when documenting or changing shipped behavior.
- Treat [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md) as design-direction context, not as proof that an interface is already implemented.
- Check the relevant package entrypoint and tests before making repo-wide claims.
- Check `examples/` when describing end-user workflows or config shape.

## Task Routing

Open the smallest relevant doc first:

| Task | Primary doc |
| --- | --- |
| Plugin system, config lifecycle, task registry, CLI boot flow | [`docs/architecture.md`](docs/architecture.md) |
| Source discovery, package materialization, `leo build`, ABI parsing, codegen | [`docs/compiler.md`](docs/compiler.md) |
| Network configs, devnode/HTTP, `node`, `run`, SDK integration | [`docs/network.md`](docs/network.md) |
| Deployment state, `deploy`, the thin `upgrade` task, `export` | [`docs/deployment.md`](docs/deployment.md) |
| SDK vs Leo CLI deploy backends, backend selection, Leo argv/env mapping, backend security | [`docs/deploy-backends.md`](docs/deploy-backends.md) |
| `@lionden/testing`, managed devnode lifecycle, fixtures, assertions, test task | [`docs/testing.md`](docs/testing.md) |
| Repo-wide test strategy, CI lane split, testing rollout proposal | [`docs/testing-strategy.md`](docs/testing-strategy.md) |
| JSON ABI schema, type serialization, compiler-vs-TS normalization | [`docs/json-abi.md`](docs/json-abi.md) |
| Leo v4 `dyn record`, V15 record-existence, id-only dynamic record recovery, dynamic-record example maintenance | [`docs/research/dynamic-records-v15.md`](docs/research/dynamic-records-v15.md) |
| Package map, examples, scaffolder, contributor entry points | [`docs/project-layout.md`](docs/project-layout.md) |
| Leo version support, v3.5 compatibility, `leoBinary`, devnode consensus heights, `lib.leo` limitations | [`docs/leo-version-compatibility.md`](docs/leo-version-compatibility.md) |
| Product goals, design decisions, Leo/SDK baseline, roadmap, known challenges | [`docs/vision-and-roadmap.md`](docs/vision-and-roadmap.md) |
| What features are shipped / missing for V1 / deferred; doko-js parity reference | [`docs/feature-status.md`](docs/feature-status.md) |
| Agent-driven disposable bug-hunt probes | [`docs/agent-bug-hunt-workflow.md`](docs/agent-bug-hunt-workflow.md) |
| Changesets, coordinated package versions, npm publishing, tags, GitHub Releases | [`docs/ci-cd/RELEASING.md`](docs/ci-cd/RELEASING.md) |

## Ground Truth Order

When sources disagree, use this order:

1. Relevant implementation files in `packages/`
2. Focused docs in `docs/`
3. Examples under `examples/`
4. `docs/vision-and-roadmap.md` for design direction and roadmap framing

## Working Expectations

- Distinguish clearly between current implementation and planned architecture.
- Cite concrete package paths before summarizing a subsystem.
- Avoid claiming that a workflow is stable unless you verified it in code or tests.
- When running Vitest in agent workflows, prefer `npm run test:agent` for the full suite or `npx vitest run --reporter=agent ...` for targeted runs. Vitest's `agent` reporter minimizes passing-test noise and token usage. Use `npm run test:unit` or `npm run test:contract` to run specific lanes.
- Avoid adding a fixed `reporters` setting to shared Vitest config unless you intentionally want to override agent-aware reporter auto-detection or explicitly preserve `agent`.
- Use `--ignore-scripts` for dependency installs, including `npm install --ignore-scripts` and `npm ci --ignore-scripts`.
- If `node` or `npm` is missing from `PATH`, load `nvm` and use the repo version before concluding the toolchain is unavailable:
  `source "$HOME/.nvm/nvm.sh" && nvm use`
- Keep edits aligned with the focused docs split:
  - broad overview in `README.md`
  - subsystem depth in `docs/*.md`
  - agent routing and doc loading policy in `AGENTS.md`
- Treat the 11 public packages as one fixed release train. Do not remove a package from the
  `.changeset/config.json` fixed group or introduce independent public versions without an
  explicit product decision. `@lionden/test-internals` stays private and outside the group.
- `create-lionden` derives every generated `@lionden/*` range from its own package version; do
  not replace that with literal per-package ranges. A Version Packages PR is ready only when
  `npm run validate:release-state -- --base origin/main` and the lockfile guard pass: one version
  across all 11 public manifests, no unreleased changesets, and exactly the version `main`'s
  pending changesets plan.
- Recovery from the partial 0.2 publication is valid only for the exact version map encoded in
  `scripts/release-policy.mjs`. Keep the fixed group active and require convergence at 0.3.0;
  never rewrite the committed fixed group. Any other future version skew is an error.
- Never edit a public `package.json` `version` by hand. CI compares every PR's public manifest
  versions against its merge base and fails on any change; only the Version Packages PR from this
  repository (`changeset-release/main` into `main`) is exempt, and it is validated instead.
- Never publish from a machine. There is no `npm run release`; `release-publish.yml` is the
  only sanctioned publisher, and npm packages disallow token publishing.
- Never run `changeset pre`. A present `.changeset/pre.json`, tracked or not, is rejected by
  every release planner entry point; prerelease mode requires an explicit policy change.
- Changesets may only name the 11 public packages. `npm run check:release-plan` assembles the
  real pending changesets without writing files and CI runs it on every PR; run it locally after
  adding or editing a changeset, before committing.
- Two recovery cases, never mixed (see `docs/ci-cd/RELEASING.md` § Recovery). Package versions
  missing from npm after a partial publish, and that release is still the intended one (nothing
  newer published, no source correction needed): re-run the failed `publish-npm` job from the
  original release run; `changeset publish` skips what is already published. Never re-run a
  superseded release; it would move `latest` backwards. All versions on npm but tags or Releases
  missing: use the manual `release-publish.yml` dispatch, which never executes
  `changeset publish` and only reconciles tags to npm `gitHead` and creates or verifies GitHub
  Releases. Do not re-run publication to repair metadata, and do not manually overwrite npm
  versions.
- A rerun keeps the original SHA and event: committed workflow and script fixes merged later are
  not picked up, and versions absent from that commit cannot be published. Live configuration
  (rulesets, environments, App permissions, npm access) is read at run time and can be fixed in
  place. A source-side fix needs a corrected commit on `main` and a new Version Packages PR,
  which publishes a new coordinated version and leaves the abandoned one incomplete.
- If an immutable historical npm version has unusable `gitHead` metadata, or both its tag and
  source commit are unavailable, add its exact tag and an explanation to
  `.changeset/release-tag-exceptions.json`. Never except the checked-out version or a mismatched
  remote tag; unused exceptions fail.
