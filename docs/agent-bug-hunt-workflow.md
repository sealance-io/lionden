# Agent Bug Hunt Workflow

When to read this: use this file when running an agent-driven workflow to uncover functionality bugs with disposable LionDen projects. This is a reusable template, not a list of permanent examples.

## Purpose

The workflow uses temporary, realistic LionDen projects to probe behavior that is hard to validate with isolated unit tests alone. Probes run against the real Leo CLI, Provable SDK, and devnode — the same tool versions and runtime surfaces a user encounters. This is critical because unit tests, contract tests, and golden snapshots encode *assumed* behavior of those external tools. When the real tools diverge from those assumptions (different output shapes, changed serialization, new error codes), the existing tests still pass while users hit failures. Probes catch that drift.

When a probe reveals that our implementation assumptions are wrong, the fix is twofold: correct the implementation *and* update the tests and goldens that encoded the wrong assumption. A passing golden snapshot that disagrees with real tool output is not coverage — it is a false signal.

When a probe finds a real bug, the fix belongs in the owning package and the permanent regression coverage should be added to the cheapest reliable test tier.

Disposable probes are discovery tools. They are not committed examples.

## Core Rules

- Use only devnode or an explicitly local HTTP endpoint.
- Never use public testnet/mainnet networks or real user keys.
- Use well-known devnode accounts or keys generated specifically for the probe with `leo account new`.
- Never commit generated private keys, probe projects, generated probe artifacts, or temporary notes.
- Keep each probe focused on one target feature or one small cluster of related behavior.
- When a bug is confirmed, fix the owning package and add permanent regression coverage before moving on.

## Target Selection

Start with a small functionality gap matrix. Keep it lightweight and scoped to the bug-hunt session.

```md
| Functionality | Unit Tests | Contract Tests | E2E Example | Gap |
| --- | --- | --- | --- | --- |
| <feature> | <coverage> | <coverage> | <coverage> | <untested behavior> |
```

Good targets usually sit at package boundaries:

- generated typechain bindings plus runtime execution
- local execution versus broadcast semantics
- signer switching and network execution
- dependency resolution plus deploy ordering
- upgrade compatibility plus deployment manifests
- network dependency fetching and compiler cache behavior
- config permutations (devnode vs HTTP, different networks, endpoint switching) that exercise different code paths through the same pipeline

Prefer one target per iteration. If a target exposes several independent failures, split them and fix one bug at a time.

## Probe Location

Create probes under:

```text
tmp/bug-hunts/<target-name>/
```

`tmp/` is gitignored, so the probe stays local and disposable. Do not add bug-hunt probes under `examples/`; examples are curated user-facing projects, while probes are allowed to be narrow, rough, and temporary.

## Standard Probe Files

Every probe should include:

```text
tmp/bug-hunts/<target-name>/
  lionden.config.ts
  tsconfig.json
  programs/<program-name>/main.leo
  test/<target>.test.ts
  scripts/deploy.ts
```

Use `lib.leo` instead of `main.leo` for local Leo libraries where needed.

The config must disable test-managed devnode startup because this workflow starts one manually:

```ts
import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.0.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: {
      type: "devnode",
      socketAddr: "127.0.0.1:3030",
      autoBlock: true,
      network: "testnet",
    },
  },
  testing: {
    autoStartDevnode: false,
    timeout: 120_000,
  },
});
```

The TypeScript config must include generated bindings directly:

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  },
  "include": [
    "typechain/**/*.ts",
    "test/**/*.ts",
    "scripts/**/*.ts",
    "lionden.config.ts"
  ]
}
```

## Devnode Lifecycle

All probes use a manual devnode so the same node is available for compile, test, and script phases. This matters because network dependencies are fetched during compilation, before test helpers can run.

Default health URL:

```text
http://127.0.0.1:3030/testnet/block/height/latest
```

If a probe uses a custom `socketAddr` or network, derive the URL as:

```text
http://<socketAddr>/<network>/block/height/latest
```

The `run` task resolves script paths relative to the project root, which is the directory containing `lionden.config.ts`. When using `--config tmp/bug-hunts/<target>/lionden.config.ts`, run scripts as:

```bash
node --import tsx packages/cli/src/bin.ts --config tmp/bug-hunts/<target>/lionden.config.ts run scripts/deploy.ts
```

Do not pass `tmp/bug-hunts/<target>/scripts/deploy.ts` as the script path unless it is absolute.

## Probe Runner Template

Run from the repo root. Keep the devnode process and cleanup in the same shell block so the PID is reliable.

```bash
set -euo pipefail

PROBE="tmp/bug-hunts/<target-name>"
CONFIG="$PROBE/lionden.config.ts"
HEALTH_URL="http://127.0.0.1:3030/testnet/block/height/latest"
DEVNODE_PID=""

wait_for_health() {
  for _ in $(seq 1 150); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "devnode did not become healthy: $HEALTH_URL" >&2
  return 1
}

wait_for_down() {
  for _ in $(seq 1 50); do
    if ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
}

start_devnode() {
  node --import tsx packages/cli/src/bin.ts --config "$CONFIG" node &
  DEVNODE_PID=$!
  wait_for_health
}

stop_devnode() {
  if [ -n "$DEVNODE_PID" ] && kill -0 "$DEVNODE_PID" 2>/dev/null; then
    kill "$DEVNODE_PID"
    wait "$DEVNODE_PID" 2>/dev/null || true
  fi
  DEVNODE_PID=""
  wait_for_down || true
}

cleanup() {
  stop_devnode
}
trap cleanup EXIT

# Phase 1: compile, typecheck, and run project tests.
start_devnode
node --import tsx packages/cli/src/bin.ts --config "$CONFIG" compile
npx tsc -p "$PROBE/tsconfig.json" --noEmit
node --import tsx packages/cli/src/bin.ts --config "$CONFIG" test --no-compile
stop_devnode

# Phase 2: fresh state for script workflow.
start_devnode
node --import tsx packages/cli/src/bin.ts --config "$CONFIG" run scripts/deploy.ts
stop_devnode
```

If an agent cannot keep a single shell session, write the PID to `tmp/bug-hunts/<target-name>/.devnode.pid` and make the cleanup step read that file. Always clean up devnode processes before moving to the next target so port `3030` is not poisoned.

## Test Design Rules

Project tests should use `@lionden/testing` and either rely on `testing.autoStartDevnode: false` or pass `setup({ skipDevnode: true })`.

Deploy before local generated calls. LionDen local execution fetches deployed program source from the node with `getProgram(programId)`. A generated local method such as `contract.deposit(...)` will fail with “program not found” unless the program has already been deployed to the devnode.

Use a setup or fixture step like:

```ts
import { setup, loadFixture, type TestContext } from "@lionden/testing";

async function deployFixture() {
  const ctx = await setup({ skipDevnode: true });
  try {
    await ctx.deploy("program_name", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}
```

Use generated bindings through their public methods:

- `contract.<transition>(...)` for local execution
- `contract.<transition>Broadcast(...)` for broadcast execution
- `contract.withSigner(account)` for signer overrides

Do not call protected `BaseContract` helpers such as `executeLocal()` or `broadcast()` from probe tests.

## Deploy Script Rules

`scripts/deploy.ts` should be a real user-style script. It should call `lre.tasks.run("compile")` before deployment so it works in a fresh CLI process and does not depend on in-memory state from a previous command.

Typical shape:

```ts
import type { LionDenRuntimeEnvironment } from "@lionden/core";

export default async function (lre: LionDenRuntimeEnvironment) {
  await lre.tasks.run("compile");
  await lre.tasks.run("deploy", { program: "program_name" });

  // Optionally exercise generated bindings or runtime calls here.
}
```

If the script is intentionally testing post-deployment behavior without redeploying, state that explicitly in the probe notes. Otherwise run scripts against a freshly restarted devnode to avoid duplicate deploy failures from tests that already deployed the same program.

## Success Criteria

A probe succeeds only when all relevant checks pass:

- `compile` succeeds.
- generated `typechain/**/*.ts` typechecks with the probe `tsconfig.json`.
- project tests pass.
- deployment/runtime script runs against devnode.
- any discovered bug has a permanent regression test in the owning package or example smoke suite.
- the temporary probe remains uncommitted.

For compile-only targets, the deployment script can be omitted only when the target explicitly says the runtime path is out of scope.

## Bug Handling Loop

Expect multiple review rounds per target. Fixing one layer often reveals that the next layer's assumptions were also wrong — for example, fixing a fetch mechanism may expose that the cache it writes to is scoped incorrectly, which in turn exposes that the compilation hash never included that cache input. Each round should fix one clearly scoped issue.

When a probe fails:

1. Identify the smallest owning module.
2. Reproduce the failure with the probe.
3. Add the cheapest permanent regression test that would catch the bug.
4. Fix the implementation.
5. Rebuild and run targeted tests.
6. Re-run the probe.
7. Present the diff summary and test results for review.
8. Iterate rounds 3-7 until no new issues are found. A fix that introduces a regression needs another round, not a commit.
9. Commit only the implementation fix and permanent regression test after approval.

Use this ownership guide:

```text
compile/materialization/typechain      -> packages/leo-compiler or packages/plugin-leo
task parsing/dispatch/config loading   -> packages/cli or packages/core
devnode/network execution              -> packages/network or packages/plugin-network
deploy/upgrade/manifest behavior       -> packages/plugin-deploy
test setup/helpers                     -> packages/testing or packages/plugin-test
```

## Permanent Coverage Guidance

Prefer the cheapest stable test that catches the bug:

- pure transformation bug: package unit test
- cross-package contract bug: `*.contract.test.ts`
- devnode/runtime behavior: focused example or project smoke test
- defensive fallback branch: unit or contract test with controlled fake inputs
- pipeline integration bug: unit test with injected spies and real temp directories (a fake tool binary shimmed into `PATH` can substitute for `leo` when only the pipeline orchestration matters, not the compiler output)

Test config permutations explicitly. Bugs often hide at the boundary between `type: "devnode"` and `type: "http"` configs, or between different network values that share a code path. If the probe exercises multiple config shapes, the permanent test should too.

Do not commit the disposable probe to preserve coverage. If a probe exposes a genuinely user-facing workflow gap that should become permanent documentation, convert it into a curated example or focused doc change separately.

### When probes contradict existing tests

A probe runs against the real Leo CLI, SDK, and devnode. If a probe's observed behavior contradicts what a unit test, contract test, or golden snapshot asserts, the probe is authoritative — it reflects what users actually experience. In this case:

1. Update the golden snapshot or test expectation to match real tool output.
2. Fix any implementation code that depended on the wrong assumption.
3. Note in the commit message which external tool behavior was different from what was assumed.

A test suite that passes while disagreeing with real tool output provides false confidence. Probes exist specifically to catch this drift.

## Commit Hygiene

Before staging:

```bash
git status --short
git diff --stat
```

Stage only durable changes:

- implementation fixes
- permanent tests
- relevant docs

Do not stage:

- `tmp/bug-hunts/**`
- generated probe artifacts
- generated private keys
- local logs

After the fix is reviewed and approved, commit only the bug fix and permanent regression coverage. Then delete or leave the disposable probe ignored under `tmp/`.
