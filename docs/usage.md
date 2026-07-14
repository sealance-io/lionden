# LionDen Usage Guide

A practical, end-to-end walkthrough of working with LionDen day to day. Covers the parts of the framework that ship today: scaffolding a project, configuring it, compiling Leo programs, generating TypeScript bindings, running tests against a managed devnode, deploying, upgrading, and exporting deployment data.

For deeper subsystem detail, follow the links into `docs/*.md` as you go. This guide is the narrative; those are the references.

## Audience And Status

This guide is for application developers using LionDen to build, test, and deploy Aleo programs. It assumes:

- You know Leo well enough to author programs under `programs/`.
- You're comfortable with TypeScript, Node-style ESM imports, and Vitest.

LionDen is in active early development. This guide is anchored to **shipped behavior** in the current codebase and the working examples under `examples/`. The roadmap doc ([`vision-and-roadmap.md`](vision-and-roadmap.md)) describes intended future direction — don't treat anything there as already implemented. When code and docs disagree, trust the code.

## Prerequisites

- Node.js `^20.19.0 || >=22.12.0`.
- npm (the workspace baseline; pnpm/yarn are not exercised).
- **Leo CLI v4.3.x** available on `PATH` as `leo` by default (default `leoVersion` is `"4.3.2"`). Leo v4.2.x, v4.1.x, and v4.0.x remain supported when `leoVersion` is set to that line. LionDen invokes `leo build` and `leo devnode start` directly.
- Optional: a v3.5 Leo binary installed side-by-side if you need v3.5 deployable-program compatibility. See [`leo-version-compatibility.md`](leo-version-compatibility.md).

LionDen also uses `@provablehq/sdk` (currently `^0.11.3`) under the hood through `@lionden/network` for transaction building and broadcasting.

> **npm security**: always install with `--ignore-scripts`. Every install snippet in this guide uses it.

## Creating Or Opening A Project

### Scaffold a new project

Once `create-lionden` is published, the typical entry point is:

```bash
npm create lionden my-app -- --template hello-world
# or:
npm create lionden my-app -- --template token
```

When developing against this repository directly, run the scaffolder from source:

```bash
node --import tsx packages/create-lionden/src/bin.ts my-app --template hello-world
```

Templates currently available: `hello-world` (minimal: one program, one script, one test) and `token` (mappings, public + private transitions, richer tests).

The scaffolder writes:

```
my-app/
  package.json
  tsconfig.json
  .gitignore
  lionden.config.ts
  programs/<name>/main.leo
  scripts/deploy.ts
  test/<name>.test.ts
```

Then:

```bash
cd my-app
npm install --ignore-scripts
npx lionden compile
npx lionden test
```

### Open an existing project

Either clone it or copy one of the examples under `examples/` (`hello-world`, `token`, `multi-program`, `nft-registry`, `async-escrow`) into a fresh directory. For Leo compatibility patterns, also inspect the focused aleo-ports such as `examples/aleo-ports/dynamic_dispatch` and `examples/aleo-ports/dynamic_records`. Each example is a self-contained workspace with its own `lionden.config.ts`, `programs/`, `scripts/`, `test/`, and (sometimes) `recipes/`.

The examples are the canonical reference for "how does a real LionDen project look?" Prefer reading them over inventing your own setup.

## CLI Argument Shape

LionDen commands follow:

```bash
lionden [global-options] <task> [task-options] [task-positionals]
```

Global options include `--config`, `--network`, `--prove`, `--verbose`, `--help`/`-h`, and `--version`/`-v`. Named task options can appear before or after the task id because the final CLI parse routes them through the resolved task schema. For example, `lionden --program hello deploy` and `lionden deploy --program hello` both target the `deploy` task's `program` option.

Bare arguments are stricter. A bare argument before the resolved task id is rejected, and bare arguments after the task id must be consumed by that task's positional schema. So `lionden hello compile` and `lionden compile hello` both fail because `compile` has no positional arguments. `lionden run scripts/deploy.ts` works because `run` declares one `script` positional. `lionden test a.test.ts b.test.ts` works because the `test` task declares its `files` positional as variadic.

## CLI Output

LionDen prints a small set of always-on lifecycle logs for normal CLI, script, and recipe runs. Each task invocation starts with `Running task "<task>"`; when a later task starts in the same run, LionDen prints a `----------------------------------------` divider first. Nested task calls use the same marker, so a script or test that invokes `compile` or `deploy` shows where that task begins.

Task-specific logs describe domain work. `compile` starts with `Compiling programs` or `Compiling <program>` and ends with a short `Compiled ...` summary. `run` prints the resolved script path and network. `recipe` prints the recipe file, export name, and network. `deploy` and `upgrade` print the program, target network, confirmation wait, and final transaction/block summary; deploy also prints when a program is skipped because it is already deployed.

Generated TypeScript contract wrappers log every transition execution through their shared base class. Outside tests, each transition block starts with the same `----------------------------------------` divider. Local calls look like `Executing token.aleo/mint(aleo1..., 1u64)` followed by `Executed token.aleo/mint (1 output)`. On-chain calls log `Submitting`, `Submitted`, `Waiting for confirmation of`, then `Accepted` or `Rejected` as the leading final status. Arguments are rendered as normal call parameters and long encoded values are truncated. If a signer override is present, logs show only `(signer: <address>)` or `(signer override)`, never the private key.

When the terminal supports color, LionDen uses restrained semantic color on the key words only: action verbs, success words, warnings/rejections, metadata such as `(tx: ...)`, and dividers. The plain text remains the same and normal terminal controls such as `NO_COLOR` are respected.

Managed test output is intentionally less visually noisy: divider lines are suppressed for the full `lionden test` flow, including the parent task and Vitest workers, but the surrounding task and transition status logs still print. LionDen also suppresses one reviewed Provable SDK edition/amendment fallback message while normal runtime SDK calls are in progress; unrelated console errors still pass through.

## Project Layout

A standard LionDen project looks like:

```
lionden.config.ts          # plugin registration + network/deploy/test config
programs/                  # source-first Leo: one directory per program/library
  hello/main.leo           # deployable program (program <name>.aleo)
  math_utils/lib.leo       # library (compile-only; Leo v4 only)
scripts/                   # deployment + utility scripts (run via `lionden run`)
recipes/                   # reusable DeploymentRecipe modules (optional)
test/                      # Vitest suites (discovered as test/**/*.test.ts)
typechain/                 # generated TS bindings (rebuilt by `compile`)
artifacts/                 # compiler output: ABIs, .aleo bytecode, prover/verifier
deployments/               # per-network deployment state (HTTP only — devnode is ephemeral)
```

Source-first rules ([details](compiler.md#source-discovery)):

- A directory containing `main.leo` is a **program root**. Its program ID is read from `program <name>.aleo { ... }`.
- A directory containing `lib.leo` is a **library root** (compile-only, no `program {}`, Leo v4 only).
- Subtrees under a root are kept together as one compilation unit. LionDen materializes a temporary Leo CLI package under `artifacts/` before invoking `leo build` — you never maintain a Leo package layout by hand.

## Configuring LionDen

The config file is `lionden.config.ts` at the project root (`.js` and `.mjs` are also discovered). At minimum it registers the four built-in plugins and picks a default network:

```ts
import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.3.2",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  testing: { timeout: 120_000 },
});
```

Plugins are **declarative**: there is no auto-discovery. Drop a plugin from the list and you lose its tasks.

### Common fields

| Field | Purpose | Default |
| --- | --- | --- |
| `leoVersion` | Compatibility line — `4.3.x`, `4.2.x`, `4.1.x`, `4.0.x`, or `3.5.x` ([details](leo-version-compatibility.md)) | `"4.3.2"` |
| `leoBinary` | Path to the Leo CLI to invoke. Tilde-expanded. | `"leo"` from `PATH` |
| `programsDir` / `artifactsDir` / `typechainDir` | Source/output layout | `programs` / `artifacts` / `typechain` |
| `defaultNetwork` | Named `networks` entry selected by tasks when no global `--network <name>` is passed | `"devnode"` |
| `networks` | Map of named network configs (`devnode` or `http`) | implicit `devnode` |
| `namedAccounts` | Per-role account values, optionally per network ([details](deployment.md#named-accounts)) | `{}` |
| `compiler` | `leo build` knobs: `enableDce`, `conditionalBlockMaxDepth`, `buildTests`, `extraFlags` | sensible defaults |
| `codegen.enabled` | Generate `typechain/` on each compile | `true` |
| `codegen.dynamicRecords` | Emit `Leo.dynamicRecord(...)` helpers ([details](json-abi.md#interface-conversion-helpers-codegendynamicrecords)) | — |
| `execution.imports` | Runtime imports for dynamic-dispatch targets ([details](network.md#runtime-imports-for-dynamic-dispatch)) | `{}` |
| `testing.timeout` | Per-test timeout in ms | `120_000` |
| `testing.autoStartDevnode` | Whether `setup()` auto-starts a devnode | `true` |
| `deploy.confirmTransactions` / `confirmationTimeout` | Wait for confirmation; ms cap | `true` / `60_000` |
| `deploy.skipDeployed` | Skip programs already on-chain | `true` |
| `deploy.autoExport` | Write an export bundle after each deploy/upgrade | `false` |
| `deploy.ephemeral` | Global override for ephemeral deployment state | type-based |

For a complete list, read `packages/config/src/types.ts`.

### Network types

Two variants today:

```ts
// Local devnode managed by LionDen
devnode: { type: "devnode", autoBlock: true }

// External or remote node — required for testnet/mainnet
testnet: {
  type: "http",
  endpoint: "https://api.explorer.provable.com/v1",
  network: "testnet",
  privateKey: configVariable("DEPLOYER_KEY"),
}
```

Devnode networks default to **ephemeral mode**: deployment state lives only in memory. HTTP networks default to **disk-backed** state under `deployments/<network>/`. See [`deployment.md`](deployment.md#deployment-state) for the override matrix.

### Config variables

`configVariable("NAME")` reads from `process.env.NAME` at config-resolution time. Note: resolution is **eager** — values are resolved for *every* network at config load, not lazily for the active one. If you `configVariable()` a key with no default, the env var must be set even on devnode runs. Comment out per-network entries that reference env vars you don't always set.

```ts
import { defineConfig, configVariable } from "@lionden/config";

export default defineConfig({
  networks: {
    devnode: { type: "devnode", autoBlock: true },
    // Uncomment when you actually deploy to testnet:
    // testnet: {
    //   type: "http",
    //   endpoint: "https://api.explorer.provable.com/v1",
    //   network: "testnet",
    //   privateKey: configVariable("ALEO_PRIVATE_KEY"),
    // },
  },
});
```

## Compile And Typechain

```bash
lionden compile                    # compile all programs + regenerate typechain/
lionden compile --program token    # compile only token + transitive deps
lionden compile --force            # bypass the cache
lionden compile --no-typechain     # skip TS binding generation
```

What `compile` does ([full pipeline](compiler.md#current-compile-pipeline)):

1. Discovers compilation units under `programs/`.
2. Resolves the dependency graph (local + network).
3. Materializes temporary Leo CLI packages under `artifacts/.build/`.
4. Runs `leo build` per unit in topological order.
5. Parses `build/abi.json` per program.
6. Copies `abi.json`, `main.aleo`, prover, and verifier into `artifacts/<programId>/`.
7. Generates `typechain/<Name>.ts`, `typechain/BaseContract.ts`, and `typechain/index.ts` (unless `--no-typechain`).

Caching is content-hash based and stored under `artifacts/.cache`. Use `--force` if a network dependency changed or you want a clean rebuild.

`lionden clean` removes `artifacts/` and `typechain/` (deployment state under `deployments/` is preserved).

`compile` logs immediately when compilation starts, then prints a compact completion summary that names a single compiled program when there is one, otherwise summarizes the compiled program/library count and whether typechain bindings were generated or skipped.

### Working With Generated Bindings

For each compiled program, codegen emits a typed wrapper that exposes every transition and mapping. Import the factory from `typechain/<Name>.ts` (or the barrel `typechain/index.ts`):

```ts
import { createTokenContract } from "../typechain/index.js";

const token = createTokenContract();
token.connect(ctx.lre);                       // bind to a runtime
token.programId;                              // "token.aleo"
token.address();                              // deterministic program address

// Local execution — no transaction, no broadcast. Returns decoded outputs.
const sum = await hello.main.locally(3, 5);

// On-chain — build + broadcast, then assert acceptance.
await token.mint_public.accepted(receiver, 100n);

// Per-call signer override:
await token.transfer_public.accepted(receiver, 50n, { signer: account1 });

// Or pin a signer for a chain of calls:
await token.withSigner(account1).transfer_public.accepted(receiver, 50n);

// Mapping reads — each mapping is exposed under `mappings.<camelName>`, mirroring
// Leo's read operations:
await token.mappings.balances.contains(account1);       // boolean — like Leo `contains`
await token.mappings.balances.get(account1);            // value — like Leo `get`; throws MappingKeyNotFoundError if the key is absent
await token.mappings.balances.getOrUse(account1, 0n);   // value or fallback — like Leo `get_or_use`
await token.mappings.balances.tryGet(account1);         // value or null when the key is absent
```

Use `.get` when the key is guaranteed to exist (it returns a non-nullable value and
throws a typed `MappingKeyNotFoundError` otherwise), `.tryGet` when absence is expected,
`.getOrUse` for a default, and `.contains` for existence checks. Note: for a mapping
whose value is an `Option`, `.get`/`.tryGet` are about *key* presence — a present-but-`None`
value still resolves to `null`. This means `.tryGet` alone *cannot* distinguish a missing
key from a stored `None` (both return `null`); use `.contains` to settle presence first,
then `.get`. See [`compiler.md` § Option-valued mappings](compiler.md#option-valued-mappings)
for the full state table.

Every transition gets several call shapes: `.locally`, `.failsLocally`, `.captureLocalFailure`, `.submitted`, `.settled`, `.accepted`, `.rejected`. Use `.accepted` for the happy path on-chain, `.rejected` to assert finalizer rejection, and `.settled` when either is acceptable. See [`testing.md`](testing.md#typed-broadcast-results) for the typed-output contract, including how `EncryptedRecord<T>` and `EncryptedValue<T>` decrypt private outputs.

When a transition isn't representable in the typed wrapper (e.g., the ABI changed after upgrade in the same test process), drop down to the raw escape hatch:

```ts
await ctx.raw.execute("counter.aleo", "decrement", []);
```

## Running Tests

```bash
lionden test                              # compile then run vitest under test/**/*.test.ts
lionden test test/counter.test.ts          # run one test file
lionden test "test/**/*.integration.test.ts" # run a glob subset
lionden test --no-compile                 # skip recompile (artifacts must already exist)
lionden test --grep "transfer_public"     # filter by test name
lionden test test/counter.test.ts --grep "increment" # combine file and test-name filters
lionden test --timeout 240000             # override per-test timeout (ms)
lionden test --prove                      # force proof generation, including devnode deploy/upgrade builders
```

File and glob arguments are interpreted from the LionDen project root and still run through LionDen's compile step, testing hooks, and managed devnode lifecycle. `--grep` applies Vitest's test-name pattern inside the selected files.

Tests use Vitest plus `@lionden/testing`. The canonical pattern (see `examples/hello-world/test/hello.test.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, loadFixture, clearFixtures, type TestContext } from "@lionden/testing";
import { createHello } from "../typechain/Hello.js";

async function deployHello() {
  const ctx = await setup();
  try {
    await ctx.deploy("hello", { noCompile: true });
    return { ctx };
  } catch (error) {
    await ctx.teardown();
    throw error;
  }
}

let ctx: TestContext | undefined;

beforeAll(async () => {
  const fixture = await loadFixture(deployHello);
  ctx = fixture.ctx;
});

afterAll(async () => {
  if (ctx) await ctx.teardown();
  else clearFixtures();
});

describe("hello program", () => {
  const hello = createHello();
  beforeAll(() => hello.connect(ctx!.lre));

  it("adds two numbers", async () => {
    expect(await hello.main.locally(3, 5)).toBe(8);
  });
});
```

What `setup()` gives you:

- `ctx.lre` — the runtime environment, including resolved config and managers
- `ctx.connection` — the active `NetworkConnection`
- `ctx.network` — the connected network name
- `ctx.accounts` — well-known devnode accounts (empty array on HTTP)
- `ctx.namedAccounts` and `ctx.named.signer(...)` / `.address(...)` / `.require(...)` — see [Named Accounts](#named-accounts)
- `ctx.deploy(nameOrWrapper, opts?)`, `ctx.execute(...)`, `ctx.raw.execute(...)`, `ctx.advanceBlocks(n)`, `ctx.teardown()`

`ctx.deploy()` accepts a program name, a `.aleo` id, or a generated wrapper, and can return a cached complete deployment `{ programId, txId }` when the program is already deployed in the connected context. Pass `{ noSkipDeployed: true }` when a test fixture must prove the deploy happened in that run.

`setup()` honors `testing.autoStartDevnode`. The devnode is started once per `loadFixture()` and torn down by `teardown()`. `loadFixture()` caches the result across tests in the same file/suite — keep deploy logic in the fixture function so you don't redeploy per test.

`TestContext` structurally satisfies `DeploymentContext` from `@lionden/plugin-deploy`, so a deployment recipe written for the CLI can be called directly from a test fixture without casts. See `examples/token/test/token.test.ts` for a recipe-driven fixture.

Helpers re-exported from `@lionden/testing`: `loadFixture`, `clearFixtures`, `assertMappingValue`, `assertBalanceAtLeast`, `assertBlockHeightAtLeast`, and account/network utilities. See [`testing.md`](testing.md#fixtures-and-assertions).

## Running A Devnode

For ad-hoc development outside of tests, run a managed devnode:

```bash
lionden node                  # http://127.0.0.1:3030, auto-block on
lionden node --port 4040
lionden node --manual-blocks  # block production driven by `leo devnode advance`
```

The process stays alive until `Ctrl-C`. Auto-block produces blocks automatically (the default); `--manual-blocks` requires you to advance manually with the Leo CLI.

If you're targeting v3.5 constructor programs on a Leo **< 4.3** devnode, add `consensusHeights` to the devnode network config so V9 activates at the expected block. On Leo **4.3+** the flag was removed — the devnode auto-activates the latest consensus version (incl. V16/V17) and LionDen rejects `consensusHeights`. See [`leo-version-compatibility.md`](leo-version-compatibility.md#devnode-consensus-heights).

## Scripts And LRE Context

`lionden run <script>` executes a TypeScript file with the LRE injected. The script must export `default` or `main` as `async (lre) => unknown`:

```ts
// scripts/deploy.ts
import type { LionDenRuntimeEnvironment } from "@lionden/core";

export default async function (lre: LionDenRuntimeEnvironment) {
  await lre.tasks.run("compile");
  const deployResult = (await lre.tasks.run("deploy", { program: "hello" })) as {
    mode: "deploy";
    results: Array<{ programId: string; txId: string }>;
  };
  const { programId, txId } = deployResult.results[0]!;
  console.log(`Deployed ${programId} — tx: ${txId}`);
}
```

Run it:

```bash
lionden run scripts/deploy.ts
lionden run scripts/deploy.ts --network testnet
```

Before importing the script, LionDen logs the resolved script path and selected network.

The script's network defaults to `config.defaultNetwork` (or the global `--network` if provided). The LRE exposes:

- `lre.config` — fully resolved config
- `lre.tasks.run(id, args?)` — invoke any registered task
- `lre.network` — the network manager (`connect`, `execute`, `getMappingValue`, …)
- `lre.deployments` — deployment manager (records, ABI snapshots, export, etc.)
- `lre.artifacts` — in-memory artifact store populated by `compile`
- `lre.namedAccounts` — resolved named accounts for the active network
- `lre.hooks` — hook dispatcher

This is the same interface tests use through `ctx.lre`.

## Deploying Programs

```bash
lionden deploy                            # compile + deploy all programs
lionden deploy --program token            # compile + deploy token (and its local deps)
lionden deploy --network testnet          # select config.networks.testnet
lionden deploy --no-compile               # use existing artifacts
lionden deploy --preflight                # validation only — no compile, no broadcast
lionden deploy --dry-run                  # build but don't broadcast (devnode only)
lionden deploy --priority-fee 50000       # microcredits
lionden deploy --skip-confirm             # don't wait for confirmation
lionden deploy --export                   # write the export bundle afterwards
lionden deploy --no-skip-deployed         # fail if any target is already on-chain
```

What `deploy` does ([full reference](deployment.md#deploy-task)):

1. Compiles unless `--no-compile` or `--preflight`.
2. Connects to the resolved network.
3. Resolves topological order across deployable programs.
4. Runs preflight: on-chain status, fee estimation (HTTP), balance (HTTP), …
5. Writes pending marker (non-ephemeral networks).
6. Builds and broadcasts via the Provable SDK. Devnode uses fast-path `buildDevnode*` builders that skip proof generation.
7. Waits for confirmation up to `deploy.confirmationTimeout` unless `--skip-confirm`.
8. Records the deployment in memory (devnode) or under `deployments/<network>/<programId>.json` (HTTP).
9. Fires the `deployment.programDeployed` hook.

Deployment state, ephemeral mode, pending recovery, and the export schema all live under [`deployment.md`](deployment.md#deployment-state).

During deploy, LionDen logs each program as it starts, prints already-deployed skips, logs when it is waiting for transaction confirmation, and prints the final deployed transaction and block. When several programs deploy sequentially, each program's lifecycle is grouped in the terminal output.

### Deployment recipes

For multi-step setup (deploy several programs, mint initial state, configure roles, …), use a **recipe** instead of a one-shot deploy script. A recipe is a TypeScript module exporting a `DeploymentRecipe`:

```ts
// recipes/setup.ts
import type { DeploymentRecipe } from "@lionden/plugin-deploy";
import { createTokenContract } from "../typechain/index.js";

export const setupToken: DeploymentRecipe = async (ctx) => {
  const { deployer, treasury } = ctx.named.require({
    deployer: "signer",
    treasury: "address",
  });
  const token = createTokenContract().connect(ctx.lre);
  await ctx.deploy(token, { noSkipDeployed: true });

  await token.withSigner(deployer).mint_public.accepted(treasury, 1_000_000n);
};

export default setupToken;
```

Run from the CLI:

```bash
lionden recipe --file recipes/setup.ts
lionden recipe --file recipes/setup.ts --export setupToken       # named export
lionden recipe --file recipes/setup.ts --network testnet
lionden recipe --file recipes/setup.ts --no-compile
```

Or from a test, since `TestContext` structurally satisfies `DeploymentContext`:

```ts
await setupToken(ctx);
```

The recipe task compiles once up front, then individual `ctx.deploy()` calls default to `noCompile: true`. `ctx.deploy()` may return an existing complete deployment record; pass `{ noSkipDeployed: true }` for first-time-only setup recipes that should fail instead of reusing an existing deployment.

Before calling the recipe export, LionDen logs the resolved recipe module, export name, and network.

## Upgrading Programs

`upgrade` is a thin task: it recompiles the program, builds and broadcasts the upgrade transaction, and records a minimal updated record. Renamed upgrades rely on the recorded local source/runtime mapping in LionDen deployment state. LionDen does **not** validate ABI compatibility, constructor immutability, edition continuity, or admin identity — Leo's built-in tooling owns upgrade correctness.

```bash
lionden upgrade --program counter
lionden upgrade --program counter --network testnet
lionden upgrade --program counter --priority-fee 100000 --skip-confirm
```

What `upgrade` does:

1. Connects to the target network.
2. Recovers any pending deployments.
3. Recompiles the program.
4. Broadcasts the upgrade transaction (devnode fast-path or HTTP build-then-broadcast).
5. Waits for confirmation unless `--skip-confirm`.
6. Records the updated state; fires `deployment.programUpgraded`.

The task returns `{ programId, txId, blockHeight }`. When `namedAccounts.admin` is signable, its key is selected as the signer (selection only — no address-match check). For v3.5 to v4 migration notes, see [`leo-version-compatibility.md`](leo-version-compatibility.md#migration-notes-v35-to-v4). To spot-check runtime upgrade behaviour, use a disposable probe per [`agent-bug-hunt-workflow.md`](agent-bug-hunt-workflow.md).

Upgrade logs mirror deploy's lifecycle style: start with `Upgrading <programId> on network "<name>"`, then `Waiting for confirmation ...` when confirmation is enabled, then `Upgraded <programId> (tx: ..., block: ...)`.

## Exporting Deployment Data

`export` writes a per-network bundle of deployment metadata (program ID, ABI, txId, status) for downstream consumption — frontends, CI artifacts, scripts that need addresses.

```bash
lionden export                                   # deployments/_exports/<network>.json
lionden export --network testnet
lionden export --out ./build/deployments.json    # custom path
```

`deploy --export` triggers an export immediately after a deployment. `deploy.autoExport: true` in config writes a bundle after every deploy and every upgrade.

Export bundles are written **even in ephemeral mode**. That's intentional — ephemeral devnode runs still need to hand addresses to a frontend or test rig.

## Named Accounts

Named accounts map a human role (`deployer`, `admin`, `treasury`, …) to a per-network account value. They make recipes and tests portable across devnode and HTTP without code changes.

```ts
// lionden.config.ts
import { defineConfig, configVariable } from "@lionden/config";

export default defineConfig({
  namedAccounts: {
    deployer: {
      default: 0,                                // devnode: DEVNODE_ACCOUNTS[0]
      // testnet: configVariable("DEPLOYER_KEY"),
    },
    treasury: {
      default: "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5",
    },
  },
});
```

Value types:

- **number** — devnode account index. Errors if used with an HTTP network.
- **`aleo1...` string** — bare address. Becomes an `AddressOnlyNamedAccount` (no private key, can't sign).
- **`APrivateKey1...` string** — private key; address derived at runtime. Signable.
- **`ConfigVariable`** — read from env, classified by prefix after resolution.

In recipes and tests, declare what role contract you need:

```ts
const deployer = ctx.named.signer("deployer");   // throws if address-only
const treasury = ctx.named.address("treasury");  // signable or address-only both fine
```

For multi-role setup, validate the full recipe contract at once:

```ts
const { deployer, treasury } = ctx.named.require({
  deployer: "signer",
  treasury: "address",
});
```

The deploy task auto-wires `namedAccounts.deployer` as the transaction signer when it's signable. The upgrade task selects `namedAccounts.admin` as the signer when it's signable — selection only, with no address-match validation (see [`deployment.md`](deployment.md#deployupgrade-signer-integration)).

> Reminder: `configVariable()` in `namedAccounts` is resolved **eagerly for all networks**. Comment out testnet entries until you're actually targeting testnet — otherwise devnode runs will fail with missing env vars.

## Common Workflows

### Day-to-day development loop

```bash
lionden compile        # iteratively while editing programs/
lionden test           # full test suite (compiles first by default)
lionden test test/counter.test.ts         # focus on one file
lionden test --grep "transfer_public"   # focus on one suite
```

### Deploy to a fresh devnode for manual probing

In one shell:

```bash
lionden node
```

In another:

```bash
lionden compile
lionden run scripts/deploy.ts
```

### First-time testnet deploy

1. Add an HTTP network entry to `lionden.config.ts` and reference `configVariable()` for the signing key.
2. Export the env var: `export DEPLOYER_KEY=APrivateKey1...`.
3. `lionden compile`.
4. `lionden deploy --network testnet --preflight` to validate without broadcasting.
5. `lionden deploy --network testnet` to ship it.
6. `lionden export --network testnet` to hand deployment metadata to the frontend.

### Multi-program project with cross-program calls

See `examples/multi-program`. Key ideas:

- A library (`programs/math_utils/lib.leo`) is compile-only — it's never deployed.
- A program that imports another program via `program_name.aleo::transition` automatically gets the transitive program included in topological deploy order.
- `ctx.deploy("rewards")` will deploy `treasury` first if `rewards` depends on it.

### Runtime imports for dynamic dispatch

Leo v4 dynamic dispatch (`Interface@(target)::fn(...)`) selects the target program at execute time, so LionDen cannot infer those targets from static `import` statements. Provide possible runtime targets explicitly instead of adding fake Leo imports just to make execution work.

Use config defaults when every call from a dispatching program needs the same target set:

```ts
export default defineConfig({
  execution: {
    imports: {
      "governance.aleo": ["voting_power.aleo", "quadratic_power.aleo"],
    },
  },
});
```

Use wrapper instance imports when a particular test or script wants to carry the targets with one contract object:

```ts
const router = createTokenRouter({
  imports: ["gold_token.aleo", "silver_token.aleo"],
});
router.connect(ctx.lre);
```

Use per-call imports for one focused call:

```ts
await router.demo_transfer.accepted(
  {
    token_program: Leo.identifier("gold_token"),
    owner,
    amount: 100n,
    to,
  },
  { imports: ["gold_token.aleo", "silver_token.aleo"] },
);
```

Each entry can be a bare program name, a `.aleo` program id, or a local `.aleo` path. The three layers are additive: `execution.imports[runtimeProgramId]`, wrapper instance imports, then per-call `options.imports`.

Runtime imports are execution-time dependencies only. They do not affect compile or deploy ordering, so deploy strategy/target programs explicitly before deploying or executing the dispatch hub. See `examples/aleo-ports/dynamic_dispatch` for config defaults, `examples/aleo-ports/dynamic_records` for wrapper/per-call imports, and [`network.md`](network.md#runtime-imports-for-dynamic-dispatch) for the full model.

### Dynamic record inputs and outputs

Leo v4 `dyn record` inputs need a typed dynamic-record literal on the TypeScript side. For one-off calls, build it directly with `Leo.dynamicRecord(value, schema)`:

```ts
const tokenInput = Leo.dynamicRecord(
  { owner: Leo.address(owner), amount: 100n, _nonce: Leo.group(nonce) },
  {
    owner: "address.private",
    amount: "u64.private",
    _nonce: "group.public",
  },
);
```

When a concrete record type repeatedly crosses a `dyn record` interface, configure `codegen.dynamicRecords` so compile emits a helper next to that record's generated module:

```ts
export default defineConfig({
  codegen: {
    dynamicRecords: {
      asGoldToken: {
        sourceProgram: "gold_token.aleo",
        sourceRecord: "Token",
        schema: {
          owner: "address.private",
          amount: "u64.private",
          purity: "u64.private",
          _nonce: "group.public",
        },
      },
    },
  },
});
```

Then call the dispatching wrapper with the generated helper:

```ts
import { asGoldToken } from "../typechain/GoldToken.js";

await router.route_transfer.accepted(Leo.identifier("gold_token"), asGoldToken(token), bob);
```

The same helper is also the idiomatic output matcher. Use the generated `.output.from(...)` form first: it reads as "decrypt this id-only output as the record emitted by this transition".

```ts
const accepted = await router.route_transfer.accepted(Leo.identifier("gold_token"), asGoldToken(token), bob);

const transferred = await accepted.outputs
  .match(asGoldToken.output.from("transfer", 0))
  .decrypt(bob);
```

Use `.from(name, outputIndex, { match: n })` when the same `(program, transition)` appears more than once in the callgraph. Use `.at(transitionIndex, outputIndex)` only when positional indexing is clearer than naming the source transition, or for intentional mismatch tests. If an external record's ABI is unavailable at codegen time, construct a matcher with `createRecordOutputMatcher(...)`; otherwise prefer the generated helper (`asGoldToken.output` or `GoldToken_Token.output`).

Direct record ciphertexts can still call `.decrypt(key)` directly. When you want one uniform style across direct records, `dyn record` outputs, and external `Record` outputs, call `.match(helper.output).decrypt(key)` on direct ciphertexts too.

Use `sourceProgram` when more than one compiled program declares the same record name. See `examples/aleo-ports/dynamic_records`, [`json-abi.md`](json-abi.md#interface-conversion-helpers-codegendynamicrecords), and [`network.md`](network.md#id-only-record-outputs-dyn-record-and-external-record) for the exact helper rules and id-only output error taxonomy.

### Upgradeable program with admin

- Annotate the constructor `@admin(address="aleo1...")` — this Leo v4 decorator is required to make the program upgradeable on-chain.
- Configure `namedAccounts.admin` (or rely on `connection.privateKey`) so the upgrade transaction is signed by the admin key.
- Iterate on `main.leo`, then `lionden upgrade --program counter`. LionDen does not validate ABI compat or admin identity — Leo's tooling enforces upgrade correctness on-chain.

### Typed contract wrappers in tests

See `examples/async-escrow`. Pattern:

```ts
const escrow = createEscrow();
escrow.connect(ctx.lre);
await escrow.create_escrow.accepted(42n);
expect(await escrow.mappings.escrowStatus.get(42n)).toBe(0);

// Off-chain failure (transition-level assert):
await escrow.create_escrow.failsLocally(0n);

// On-chain failure (finalizer-level assert):
const result = await escrow.fund_escrow.rejected(100n);
expect(result.status).toBe("rejected");
```

## Troubleshooting

**`No lionden.config.ts found.`** — run the CLI from a directory that contains the file, or pass `--config <path>`.

**Compile fails with a Leo version error.** — Check `leoBinary --disable-update-check --version`. The `major.minor` line of the binary must match `leoVersion`. Patch drift is allowed; minor drift is not unless you set `skipLeoVersionCheck: true`. See [`leo-version-compatibility.md`](leo-version-compatibility.md).

**Devnode starts but transactions stall.** — On Leo v3.5 devnodes (Leo < 4.3) deploying constructor programs, you must set `consensusHeights` on the devnode network so V9 activates. Leo v4 devnodes default to V9, and the Leo 4.3+ devnode auto-activates the latest consensus version (so `consensusHeights` is unsupported there).

**Devnode fails to start: address `127.0.0.1:3030` already in use (macOS).** — An orphaned devnode is still holding the port. LionDen stops its devnode with SIGTERM then SIGKILL, but a hard-killed test runner, a force-quit IDE, or a crashed CI worker can leave the child (`leo … devnode start` or `aleo-devnode start`) reparented to launchd. Find and clear it:

```bash
lsof -nP -iTCP:3030 -sTCP:LISTEN              # what holds the port (-nP = raw host:port)
ps -o pid,ppid,etime,command \
  -p "$(lsof -ti tcp:3030 -sTCP:LISTEN)"      # confirm it's a devnode; ppid 1 = orphaned
lsof -ti tcp:3030 -sTCP:LISTEN | xargs kill    # graceful SIGTERM; re-run with `kill -9` if it lingers
```

If you run a non-default `socketAddr`/`--port`, substitute that port for `3030`. Note the same "address already in use" error appears when two devnode-backed test suites run concurrently — devnode binds a fixed port, so those suites must run one at a time; serialize them rather than killing a process.

**`configVariable("X")` throws on a devnode run.** — `configVariable` is resolved eagerly for every network entry. Comment out unused per-network entries that reference env vars you haven't set, or supply a `default` value.

**Tests pass locally but `ctx.raw.execute(...)` is needed for upgraded transitions.** — The typechain class was compiled from the pre-upgrade ABI in this process. Add new transitions through `raw.execute` after the upgrade, or restart the test process so codegen picks up the new ABI.

**Deploy says "skipping — already deployed".** — Default behavior under `skipDeployed: true`. Use `--no-skip-deployed` to make it a hard error, or `upgrade --program <name>` if you meant to ship an upgrade.

**`lionden run script.ts` fails to import a `.ts` file.** — The CLI must be invoked through `tsx`. The packaged binary handles this; if running from source use `node --import tsx packages/cli/src/bin.ts run ...`.

**`npm install` runs unexpected lifecycle scripts.** — Always pass `--ignore-scripts`. Set `ignore-scripts=true` in `~/.npmrc` to make it default.

## Where To Go Deeper

This guide stays at the happy-path level. For subsystem internals, follow the focused docs:

- [`architecture.md`](architecture.md) — plugin model, config lifecycle, task registry, LRE, CLI boot flow.
- [`compiler.md`](compiler.md) — source discovery, dependency resolution, materialization, `leo build`, ABI, codegen.
- [`network.md`](network.md) — network manager, devnode lifecycle, SDK adapter, transaction confirmation, `node` and `run`.
- [`deployment.md`](deployment.md) — deploy, upgrade, export, deployment state, ephemeral mode, recipes, named accounts.
- [`testing.md`](testing.md) — `setup()`, fixtures, assertions, typed broadcast results, decryption, dynamic records.
- [`testing-strategy.md`](testing-strategy.md) — repo-wide test taxonomy and CI lanes.
- [`json-abi.md`](json-abi.md) — JSON ABI schema, serde rules, codegen type mapping.
- [`leo-version-compatibility.md`](leo-version-compatibility.md) — Leo v4 default, v3.5 deployable support, `leoBinary`, devnode consensus heights.
- [`project-layout.md`](project-layout.md) — full package map, example catalog, scaffolder template registry.
- [`vision-and-roadmap.md`](vision-and-roadmap.md) — product goals, design decisions, roadmap framing.
- [`feature-status.md`](feature-status.md) — what's shipped, what's missing for V1, what's deferred; includes a doko-js parity reference.

When in doubt, read the relevant `examples/` project before inventing a new pattern — the examples are the most reliable record of what currently works.
