# AGENTS.md

This file is the navigation layer for agents working in the LionDen repo. Load the smallest amount of documentation necessary for the task.

## Start Here

1. Read [`README.md`](/Users/mitzpetel/Workspaces/lionden/README.md) for the project overview and current status.
2. Read the relevant `docs/*.md` file for subsystem detail.
3. Open [`docs/vision-and-roadmap.md`](/Users/mitzpetel/Workspaces/lionden/docs/vision-and-roadmap.md) when you need design intent, roadmap context, or platform assumptions.

Do not load every doc up front. Most tasks only need one focused doc plus a few source files.

## Repo Snapshot

- `packages/config`: config types and helpers
- `packages/core`: plugin lifecycle, hooks, tasks, LRE
- `packages/cli`: CLI discovery, parsing, help, dispatch
- `packages/leo-compiler`: Leo source discovery, dependency resolution, materialization, compile pipeline, codegen
- `packages/network`: network manager, Aleo connection, devnode/devnet helpers, SDK adapter
- `packages/testing`: test LRE setup, devnode lifecycle, fixtures, assertions
- `packages/plugin-*`: default task plugins
- `packages/create-lionden`: project scaffolding
- `examples/`: concrete user-facing projects
- `docs/`: focused deep dives for lazy loading

## Selective Disclosure Rules

- Prefer `README.md` plus one subsystem doc over broad doc loading.
- Prefer current code over plan docs when documenting or changing shipped behavior.
- Treat [`docs/vision-and-roadmap.md`](/Users/mitzpetel/Workspaces/lionden/docs/vision-and-roadmap.md) as design-direction context, not as proof that an interface is already implemented.
- Check the relevant package entrypoint and tests before making repo-wide claims.
- Check `examples/` when describing end-user workflows or config shape.

## Task Routing

Open the smallest relevant doc first:

| Task | Primary doc |
| --- | --- |
| Plugin system, config lifecycle, task registry, CLI boot flow | [`docs/architecture.md`](/Users/mitzpetel/Workspaces/lionden/docs/architecture.md) |
| Source discovery, package materialization, `leo build`, ABI parsing, codegen | [`docs/compiler.md`](/Users/mitzpetel/Workspaces/lionden/docs/compiler.md) |
| Network configs, devnode/devnet, `node`, `run`, `deploy`, `upgrade` | [`docs/network-and-deploy.md`](/Users/mitzpetel/Workspaces/lionden/docs/network-and-deploy.md) |
| `@lionden/testing`, managed devnode lifecycle, fixtures, assertions, test task | [`docs/testing.md`](/Users/mitzpetel/Workspaces/lionden/docs/testing.md) |
| Package map, examples, scaffolder, contributor entry points | [`docs/project-layout.md`](/Users/mitzpetel/Workspaces/lionden/docs/project-layout.md) |
| Product goals, design decisions, Leo/SDK baseline, roadmap, known challenges | [`docs/vision-and-roadmap.md`](/Users/mitzpetel/Workspaces/lionden/docs/vision-and-roadmap.md) |

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
- When running Vitest in agent workflows, prefer `npm run test:agent` for the full suite or `npx vitest run --reporter=agent ...` for targeted runs. Vitest's `agent` reporter minimizes passing-test noise and token usage.
- Avoid adding a fixed `reporters` setting to shared Vitest config unless you intentionally want to override agent-aware reporter auto-detection or explicitly preserve `agent`.
- If `node` or `npm` is missing from `PATH`, load `nvm` and use the repo version before concluding the toolchain is unavailable:
  `source "$HOME/.nvm/nvm.sh" && nvm use`
- Keep edits aligned with the focused docs split:
  - broad overview in `README.md`
  - subsystem depth in `docs/*.md`
  - agent routing and doc loading policy in `AGENTS.md`
