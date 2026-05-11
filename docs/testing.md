# Testing

When to read this: use this file for `@lionden/testing`, the `test` task, devnode lifecycle in tests, fixtures, and assertion helpers.

## Current Testing Model

LionDen uses Vitest rather than a custom test runner. The repo provides:

- `@lionden/testing` for programmatic test setup and helpers
- `@lionden/plugin-test` for the `test` CLI task

The intended pattern is:

1. create a test context with `setup()`
2. optionally deploy one or more programs
3. execute transitions through the network connection
4. use assertion helpers and fixtures
5. tear the context down after the suite

This testing approach is built around a devnode-first workflow, suite-level isolation, and ordinary Vitest lifecycle hooks rather than a custom LionDen-owned test framework.

## `setup()` And Test Context

`packages/testing/src/test-context.ts` defines the primary testing surface.

`setup()` currently:

- creates or reuses an LRE
- optionally starts a managed devnode
- connects to the selected network
- exposes well-known devnode accounts when connected to devnode, otherwise an empty account list
- returns helpers for deploy, execute, advance blocks, and teardown

The resulting `TestContext` includes:

- `lre`
- `accounts`
- `namedAccounts` — resolved named accounts for the active network (see [deployment.md § Named Accounts](deployment.md#named-accounts))
- `named` — required-role accessor for named accounts
- `connection`
- `network`
- `deploy()`
- `execute()`
- `raw.execute()` — explicit string-based escape hatch for dynamic ABI or post-upgrade transition calls
- `advanceBlocks()`
- `teardown()`

This is the interface used by the example tests in `examples/`.

Generated typechain wrappers are preferred when the ABI is known. Use `ctx.raw.execute(...)` only when the typed wrapper cannot describe the call, such as a transition introduced by an upgrade after the test process loaded the v1 typechain class. `ctx.execute(...)` remains available for compatibility with older tests.

`deploy()` checks the deployment manager cache before invoking the `deploy` task. This avoids redeploying a program already deployed in the same session. `teardown()` invalidates the deployment cache for the connected network so the next test context revalidates state against the active network. The `network` property on `TestContext` exposes the connected network name. `TestContext` structurally satisfies `DeploymentContext` from `@lionden/plugin-deploy`, so deployment recipes can be called directly from test fixtures without any explicit type casting.

`namedAccounts` is populated from `lre.namedAccounts` after `connect()`. It holds `{}` when no `namedAccounts` field is present in the project config — existing tests continue to work unchanged. New tests should prefer `ctx.named.signer(...)`, `ctx.named.address(...)`, or `ctx.named.require(...)` for required named-account roles.

## Devnode Lifecycle In Tests

`packages/testing/src/devnode-lifecycle.ts` wraps `DevnodeManager` for test suites.

Current behavior:

- derives defaults from the first configured devnode network when available
- starts a devnode unless the caller skips it
- returns a managed handle with endpoint metadata
- tears it down during cleanup

`setup()` respects `config.testing.autoStartDevnode`.

## Test Runner Task

`packages/plugin-test/src/index.ts` exposes the `test` task.

Current flow:

1. run `compile` unless `--no-compile` is set
2. dispatch testing suite setup hooks
3. run Vitest through `packages/plugin-test/src/test-runner.ts`
4. dispatch testing suite teardown hooks

Current task options:

- `--grep`
- `--timeout`
- `--no-compile`
- `--prove`

`--prove` is forwarded through `LIONDEN_PROVE=true` so test execution can force proof generation.

## Vitest Integration

The programmatic Vitest runner currently:

- sets `LIONDEN_PROJECT_ROOT` so worker processes can rediscover the project config
- scopes test discovery to `test/**/*.test.ts`
- applies timeout overrides from task args or config
- returns summarized pass/fail counts

Vitest remains a peer dependency of `@lionden/plugin-test`.

## Fixtures And Assertions

`@lionden/testing` re-exports helpers for:

- fixtures via `loadFixture()` and `clearFixtures()`
- mapping and transaction assertions
- balance assertions
- block-height assertions
- well-known devnode accounts

This lets test suites stay concise without reimplementing common network checks.

## Strategy And Design Direction

For the proposed repo-wide testing strategy, lane split, and rollout plan, use [`testing-strategy.md`](testing-strategy.md).

For the rationale behind the Vitest-based testing model, devnode-first assumptions, and known testing constraints, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the testing package and example suites for current reality.
