# Deploy Backends

When to read this: use this file to choose between the SDK and Leo CLI backends for `deploy` and `upgrade`, and for the flag mapping, selection ladder, limitations, and security properties of the Leo backend. For deployment state, records, preflight, and hooks — all backend-agnostic — use [`deployment.md`](deployment.md).

## What A Backend Owns

A deploy backend owns turning a compiled program into a deployment or upgrade transaction. Everything around it is backend-agnostic and does not move:

| Owned by the backend | Owned by `plugin-deploy`, either backend |
| --- | --- |
| Building the deploy/upgrade transaction | Topological ordering across local dependencies |
| Proving key synthesis | Pending markers and crash recovery |
| Fee estimation, where supported | Confirmation polling, inter-deployment delay |
| — | Deployment records, ABI snapshots, history, export |
| — | Preflight, `--dry-run`, `--skip-deployed`, hooks |

The seam is `DeployBackend` in `packages/plugin-deploy/src/deploy-backend/types.ts`. Both implementations sit beside it: `sdk-backend.ts` and `leo-backend.ts`.

**Broadcast is the one thing a backend may or may not own.** `DeployBackendResult` has two arms, and both predate the seam:

- `{ kind: "built", transaction }` — the backend hands back a transaction and `plugin-deploy` broadcasts it. This is the Leo backend on every network, and the SDK backend on devnode and for every upgrade.
- `{ kind: "broadcast", txId }` — the backend already broadcast it. This is the SDK backend's HTTP deploy path only, where `ProgramManager.deploy` builds and submits atomically and there is no intermediate transaction to hand back.

That asymmetry is why `--dry-run` is a declared capability rather than something every backend can do.

Execution (`run`, `ctx.execute`, typechain calls) is **not** part of this seam. Every execution path stays on the SDK regardless of `deploy.backend`.

## Why Two Backends

The SDK backend builds a deployment in one monolithic WASM operation, synthesizing and retaining keys for every function of the program *and* for every function it calls across its import closure — those are re-derived from source, not read back from the chain — until the whole thing completes. A large enough deployment exhausts WASM's ~4 GiB ceiling during key setup and hangs before control returns to JavaScript. Nothing is persisted, so there is no partial progress to resume: the next attempt starts from zero and hits the same wall.

The closure term matters more than program size. snarkVM caps a single program at 2,097,152 variables, and the SDK deploys the largest such program in about five minutes — so a program alone will not do this. Four moderate libraries and a thin program that imports them will: measured, the SDK pins around 4.8 GB and never returns, while Leo deploys the same program in 54 seconds — wanting a comparable amount of memory, which it can have because it is a native process rather than a 32-bit WASM one. See [Testing](#testing).

The Leo CLI runs as a separate process with no WASM ceiling, and caches synthesized keys under `~/.aleo`. A failed or timed-out run resumes cheaply: re-running skips the keys already synthesized.

That is the reason the Leo backend exists. For programs that deploy comfortably through the SDK there is no reason to switch.

| | `sdk` (default) | `leo` |
| --- | --- | --- |
| Transaction building | `@provablehq/sdk` `ProgramManager`, in-process WASM | `leo deploy` / `leo upgrade` child process |
| Key synthesis survives failure | No | Yes (`~/.aleo`) |
| Memory ceiling | WASM's ~4 GiB | The host's |
| Fee estimation before deploy | Yes | No — Leo prints costs as it runs |
| `--dry-run` | devnode only | any network |
| `sdk.egress` enforced | Yes | No — rejected at selection |
| `networks.<n>.apiKey` | Yes | No — rejected at selection |
| Leo versions | 3.5 – 4.3 | **4.3.x only** |
| Broadcast | LionDen, except the atomic HTTP deploy path | LionDen, always |
| Scope | deploy, upgrade | deploy, upgrade |

## Selecting A Backend

Five layers over a default, highest precedence first:

| Layer | Where |
| --- | --- |
| 1 | `DeployOptions.deployBackend` / `UpgradeOptions.deployBackend` — the programmatic per-call argument (`lre.tasks.run("deploy", { deployBackend: "leo" })`) |
| 2 | `--deploy-backend <sdk\|leo>` (global CLI flag) |
| 3 | `LIONDEN_DEPLOY_BACKEND=<sdk\|leo>` |
| 4 | `networks.<name>.deployBackend` |
| 5 | `deploy.backend` |
| 6 | default: `"sdk"` |

Layer 1 is out of reach from the CLI. `DeploymentManager.preflight()` is also out of reach of layers 1 and 2, since it takes no `args`/`lre`; the environment variable still applies there because it is process-global.

```typescript
export default defineConfig({
  deploy: {
    backend: "leo",              // project-wide default
    leo: {
      timeout: 1_800_000,        // ms per invocation; 0 disables. Default: 30 min
      logMode: "forward",        // or "quiet-buffered". Default: "forward"
    },
  },
  networks: {
    devnode: { type: "devnode" },
    testnet: {
      type: "http",
      endpoint: "https://api.explorer.provable.com/v1",
      deployBackend: "sdk",      // this network overrides the project default
    },
  },
});
```

Every layer is validated where it is read, and an unrecognized value is always a hard error rather than a silent fall-through to the default — a typo (`--deploy-backend Leo`) or a value-less flag (`--deploy-backend=`) fails immediately. The one exception is `LIONDEN_DEPLOY_BACKEND=`, which is treated as unset, matching how the shell and the rest of LionDen's env parsing treat an empty variable.

`deploy.leo` is ignored entirely when the effective backend is `"sdk"`.

There is deliberately no `deploy.leo.extraFlags` passthrough. An unrestricted one could inject `--broadcast`, `--private-key`, `--endpoint`, `--save`, `--skip`, or `--no-cache`, each of which breaks a guarantee this backend relies on.

### Where selection is validated

Compatibility is checked against the **effective** backend, not `deploy.backend`, which is why it cannot live in `validateResolvedConfig`: config resolution runs before the CLI flag and the environment variable are read, so a Leo backend chosen through `--deploy-backend`, `LIONDEN_DEPLOY_BACKEND`, or a per-network override would slip past it.

`assertDeployBackendCompatible` (`deploy-backend/resolve.ts`) runs as step 0 of `deploy` and `upgrade` — before compilation and before connecting — and rejects:

- **`sdk.egress` set.** LionDen routes every SDK network call through `makeNetworkTransport` specifically so the egress policy can be enforced at the socket. Leo issues its own HTTP requests from a separate process, where that policy cannot reach. Silently dropping a configured egress control is worse than refusing.
- **`networks.<n>.apiKey` set.** LionDen sends `Authorization: Bearer <apiKey>` on its own explorer calls. Leo 4.3 `deploy`/`upgrade` expose no header or API-key option, so its build-time queries would go out unauthenticated. This is a permanent backend limitation, not a temporary one.
- **`leoVersion` outside `4.3.x`.** See below.

It warns, rather than failing, when `sdk.keyCache.storage` is `"filesystem"`: nothing breaks, the configured cache is simply never consulted, because Leo caches under `~/.aleo`. The setting still applies to program execution.

## Leo Version Support

The Leo backend supports **Leo 4.3.x only** — narrower than LionDen's 3.5 – 4.3 compile and devnode support range. Other lines differ in their `deploy`/`upgrade` flag surface and have not been verified, and unlike a compile error a wrong flag here can produce a wrong *deployment*.

Two checks apply, and both must pass:

1. **`leoVersion`** must be on the `4.3.x` line, checked in `assertDeployBackendCompatible`.
2. **The binary itself** must report `4.3.x`, checked in `assertLeoBinaryVersion` by running `<leoBinary> --disable-update-check --version`. Memoized per binary path, so a multi-program deploy pays for it once.

The binary check exists because both mechanisms that normally tie `leoVersion` to the actual binary fail open on this path: `preflightLeo` returns before comparing versions when `skipLeoVersionCheck` is set, and it is only invoked from the compile task and `preflightDevnode` — so `lionden deploy --no-compile` runs no version check at all.

**`skipLeoVersionCheck` does not relax the deploy backend's gate.** That flag is an escape hatch for patch-level drift when compiling, not a license to run an unverified `deploy` flag surface.

## What LionDen Runs

Leo **builds only**. LionDen passes `--save` without `--broadcast`, reads the saved transaction back, and broadcasts it itself. That keeps ordering, pending markers, records, and confirmation polling exactly where they already are — and sidesteps Leo's exit-0-on-rejection behavior entirely, since without `--broadcast` Leo never learns the chain's verdict.

The full argument vector is built by `buildLeoArgv` (`deploy-backend/leo/argv.ts`) as a pure function, so the whole surface is testable as golden arrays.

| Flag | When | Why |
| --- | --- | --- |
| `--disable-update-check` | always, first | A daily update probe must never interpose on a deploy. Matches `runLeoBuild`. |
| `deploy` / `upgrade` | always, second | Same flag surface for both. |
| `--path <pkg>` | always | The materialized package at `<artifacts>/.build/<effective-program-id>`. |
| `--save <dir>` | always | Build without broadcasting. `<dir>` is a `0o700` temp directory, removed in a `finally`. |
| `--json-output=<file>` | always | Cost/stat breakdown, parsed by the outcome reader. |
| `--yes` | always | Non-interactive. |
| `--network`, `--endpoint` | always | From the live connection, not from config. |
| `--devnet` | devnode | Matches the connection type. |
| `--consensus-heights <v>` | devnode, when configured | Meaningless against a real network, which has its own schedule. |
| `--priority-fees <n>` | when non-zero | A single bare integer: `--skip` forces exactly one transaction per invocation. |
| `-f default` | private fee | "Pick fee records for me", matching the SDK's boolean. |
| `--skip <dep>` | once per local dependency | See below. |
| `--skip-deploy-certificate` | devnode **and** not `--prove` | Placeholder certificates and verifying keys, rejected by a real network. Reproduces the SDK's devnode fast path. |
| `-q` / `-d` | `sdk.logLevel` silent/error → `-q`, debug → `-d` | Warn and info emit nothing. |

Flags LionDen will **never** pass, each a decision rather than an omission:

- **`--no-cache`** — defeats the `~/.aleo` key cache, which is the resumability this backend exists to provide.
- **`--rename`** — `materializePackage` has already rewritten the program declaration into `.build/<effective-id>/`; passing it would rename a second time.
- **`--broadcast`** — takes broadcasting away from LionDen and re-exposes exit-0-on-rejection.
- **`--private-key`** — argv is world-readable through the process list. The key travels in the environment.
- `--build-tests`, `--no-local`, `--offline`, `-p`/`--package` — each either costs time or means the opposite of what is wanted here.

### `--skip` and the dependency closure

`leo deploy` and `leo upgrade` act on a package's **entire local dependency closure** by default. LionDen deploys one program per invocation — it owns ordering, and writes one pending marker and one record per program — so every local dependency must be suppressed with a repeated `--skip`.

**Leo matches `--skip` by substring, not by exact program id.** Its own help says it skips any program whose id *contains* one of the given substrings, and this was confirmed empirically: `--skip spike_a.aleo` also dropped `zspike_a.aleo`.

That makes two things load-bearing:

1. **The closure is rooted at, and subtracted by, the *source* program id.** For a renamed deploy or upgrade (`hello.aleo` deployed as `renamed_hello.aleo`), subtracting the *effective* id is a no-op — it is not a node in the source graph — and leaves `hello.aleo` in the skip list. Since `renamed_hello.aleo` contains `hello.aleo`, Leo would then skip the very program being deployed and exit 0 having built nothing.
2. **`assertNoSkipCollision` rejects any remaining collision up front.** A collision is silent and severe otherwise: Leo exits 0 with no saved transaction, surfacing only as the outcome parser's no-file error, far from the cause. The rejection names both ids and offers `--deploy-backend sdk`. The remedy is to rename one program so neither id is a substring of the other.

### Artifact identity

Two staleness checks bracket every run, and they are not redundant:

- **Pre-run** (`resolveLeoPackage`) — the materialized package must exist and be current. This exists to produce a good error early.
- **Post-run** (`assertPackageUnchanged`) — the package's compiled artifact must be byte-identical to what it was before Leo ran, checked **before the transaction is returned to be broadcast**.

The post-run check is what actually protects the invariant, because `leo deploy --path` can recompile from `src/` while it runs. A changed hash means Leo built different bytecode than LionDen is about to record, so it is a hard error that aborts before broadcast.

The saved transaction itself is verified rather than trusted by file name: `readLeoOutcome` requires exactly one saved transaction and parses it to confirm it really is a deployment of the program that was requested. A truncated write, a stale file from an earlier run, or a transaction for a different program would all pass a name check and then be broadcast and recorded as this program's deployment.

The transaction is broadcast as the exact bytes Leo saved. Re-serializing it would change field order and whitespace, which the transaction id commits to.

`readLeoOutcome` also parses a transaction id and cost stats out of those bytes and `--json-output`, but the backend returns only the bytes: the recorded `txId` is the one the network returns from the broadcast. The parsed values exist to validate the file, not to become the record.

## Capabilities And Limitations

`DeployBackendCapabilities` is what the task layer branches on, rather than sniffing the provider name.

| Capability | `sdk` | `leo` |
| --- | --- | --- |
| `buildWithoutBroadcast` | devnode only | always |
| `feeEstimation` | yes | no |
| `resumableKeySynthesis` | no | yes |

**`--dry-run`** gates on `buildWithoutBroadcast`. The SDK's HTTP path (`programManager.deploy`) is atomic build-and-broadcast, so there is no transaction to hand back without sending it; its devnode path builds first and is therefore fine. The Leo backend's `--save` without `--broadcast` is exactly a dry run on any connection type, so `--deploy-backend leo --dry-run` works against a real network.

**Fee estimation** returns a warning (`FEE_ESTIMATION_UNAVAILABLE`) rather than a number, so deploy preflight reports it without failing. Leo does compute costs and prints a full breakdown when the deployment runs; reading them back from `--json-output` is a follow-up. The SDK path is no better in the case that matters: `estimateDeploymentFee` synthesizes keys and hits the same memory wall as the deploy it is estimating.

**Not supported at all:** `sdk.egress`, `networks.<n>.apiKey`, Leo lines other than 4.3.x, and execution of any kind.

## Security Properties

Five properties hold for every Leo *deploy or upgrade* invocation — that is, every spawn that goes through `spawnLeoRunner`. Each closes a path by which a credential could leak or the wrong identity could sign.

The version gate is the one Leo invocation outside that path: it runs `execFile(<leoBinary>, ["--disable-update-check", "--version"])` directly, inheriting the ambient environment — so an ambient `PRIVATE_KEY` or `DEVNET` reaches it — with no redaction of its output. That is acceptable rather than accidental: `--version` selects no signing identity, contacts no network, and builds no transaction, so there is nothing for an inherited variable to influence. It does mean the properties below are properties of `spawnLeoRunner`, not of every process named `leo` that LionDen starts.

**The private key never appears in argv.** It travels in the child environment as `PRIVATE_KEY`, following `runRestoreCommand` in `devnode-manager.ts` — argv is world-readable through the process list. Tests assert that no argv ever matches `/APrivateKey1/`.

**LionDen never lets Leo choose the signing identity.** Leo resolves `PRIVATE_KEY` from a `.env` file in its working directory *and every parent of it*, and LionDen runs Leo with `cwd` set to the project root. An unset variable therefore does not mean "no key" — it means "whatever key is on disk". Verified against Leo 4.3.2. So the backend **refuses to spawn** when neither `networks.<n>.privateKey` nor the relevant named account (`deployer` for deploy, `admin` for upgrade) supplies one, rather than proceeding with an identity LionDen did not select. The refusal happens before package probing, temp-directory creation, and the spawn.

**No private key is written into build output on HTTP networks.** `buildDotEnv` writes no `PRIVATE_KEY` for `type: "http"`. A real network's key is a live credential, and `<artifacts>/.build/<id>/.env` is build output — routinely archived, copied into containers, and shared. Nothing needs it there: `leo build` signs nothing, and the deploy backend passes the key through the child environment instead. The devnode placeholder stays; it is the well-known key Leo itself publishes in `leo deploy --help`, so it is documentation rather than a secret.

**Every variable Leo can read from a `.env` is assigned, not deleted.** Deleting a variable from the child environment only removes the *inherited* value; the on-disk `.env` fallback remains reachable. `NETWORK`, `ENDPOINT`, and `DEVNET` are therefore all pinned to explicit values. The concrete failure this prevents: a project whose `.env` carries `DEVNET=true` from local devnode work, deployed to a real network. `--devnet` is a valueless flag with no negative form, so an explicit `DEVNET=false` is the only way to force it off.

**Output is redacted, and there is no `inherit` log mode.** `deploy.leo.logMode` offers `"forward"` (stream through as it runs) and `"quiet-buffered"` (buffer both streams, print only on failure). Both pass every line through JS, where the signing key is redacted before it reaches the console or an error's stderr tail. An `"inherit"` mode would wire the child's stdio straight to the parent's file descriptors, bypassing JS entirely, so the redaction could not hold — which is why it does not exist.

The saved transaction lands in `fs.mkdtempSync(os.tmpdir() + "/lionden-leotx-")` at mode `0o700`, removed in a `finally`. It is a signed, broadcastable payload, not a build artifact, so it never lives under `artifacts/`.

## Failure Modes

Failures that involve running Leo are `LeoDeployError` (a `DeployError` subclass, so existing task-level handling is unchanged). The useful discrimination is the `stage` field, and every message carries a concrete remedy. The tail of Leo's output is folded into `message` rather than kept in a side field, because `bin.ts` prints only `error.message` — so when there is a tail, `composeMessage` appends it *after* the remedy and the remedy sits in the middle of the message rather than at the end.

Two Leo-backend rejections are plain `DeployError` with no `stage`, because they fire before Leo is ever involved: the **missing signing key** refusal (`assertSigningKeyPresent`) and the **skip collision** rejection (`assertNoSkipCollision`). Neither has Leo output to attach.

| `stage` | Meaning |
| --- | --- |
| `version-gate` | `<leoBinary> --version` could not be run, parsed, or is not `4.3.x`. |
| `package` | The materialized package is missing or stale pre-run, or its artifact changed post-run. |
| `run` | Leo exited non-zero, or was killed by a signal. |
| `timeout` | Exceeded `deploy.leo.timeout`. |
| `outcome` | Leo exited 0 but produced no saved transaction, more than one, or one that is not a deployment of the requested program. |

A `spawn` stage exists in the `LeoDeployStage` union but no site emits it today: a failure to start the process rejects with Node's raw spawn error. In practice the version gate runs `<leoBinary> --version` at step 0, so a missing or unrunnable binary is reported there with a remedy before any deploy is attempted.

`outcome` is worth calling out. **A zero exit code does not mean success here** — Leo also exits 0 when `--skip` matches every program, which is exactly what the skip-collision guard exists to prevent.

A `timeout` is the one failure that is cheap to retry: re-running resumes from Leo's `~/.aleo` key cache, so work already done is not repeated. Raise `deploy.leo.timeout`, or set it to `0` to disable the timeout entirely, for a program whose key synthesis genuinely takes longer than 30 minutes.

## Testing

`FakeLeoCli` (`packages/plugin-deploy/src/deploy-backend/leo/fake-leo-cli.ts`) swaps the injected `LeoRunner` and records every invocation's `argv`, `env`, `cwd`, and declared `secrets`. It parses `--save` and `--json-output` out of the argv it receives and writes the configured files there, so tests exercise the real file-discovery and outcome-parsing path rather than stubbing over it. Its stdout and stderr are redacted exactly the way `spawnLeoRunner` redacts them — a fake that handed back raw output would let a test "prove" an error message is clean while the real path leaks.

Swapping the runner rather than putting a script on `PATH` is what makes the environment and argv assertions meaningful.

`leo-deploy-orchestration.contract.test.ts` drives deploy and upgrade, devnode and HTTP, through the real task layer with `FakeLeoCli` installed — real provider selection, real compatibility check, real version gate, real argv assembly, real staleness checks, real outcome parsing, with only the process boundary faked.

It is a **Leo-only** suite, not a cross-backend comparison. The SDK-backed contract test covers pending markers, records, broadcast, and hooks for `sdk` only, and none of that is shared code below `deployAction` — so "the SDK path works" says nothing about whether the Leo path writes a pending marker before broadcasting, records the right transaction, or fires the hook. This file closes that gap by asserting the Leo path's behavior directly. Proving the two backends produce *equivalent* results is the job of the parity driver below, not of either contract test.

At Tier 3, `scripts/run-smoke-examples.mjs` takes a `--deploy-backend <sdk|leo>` axis, so every example's real compile/deploy/execute workflow can be run end-to-end on either backend:

```bash
npm run test:smoke:leo-backend           # core examples, Leo backend, no proving
npm run test:smoke:leo-backend:prove     # the same with real proof generation
```

The lane refuses to run on a binary outside `4.3.x` rather than skipping, because a silently-skipped opt-in lane is a green result that exercised nothing. The `leo-samples` lane does **not** take this axis: it is pinned to Leo 4.2.0 / consensus V15, which this backend does not support.

Two Tier 4 lanes carry what nothing above them can:

```bash
npm run test:deploy-backend-parity   # SDK vs Leo, real chain, normalized record comparison
npm run test:deploy-backend-scale    # the memory-wall acceptance harness
```

**Parity** (`scripts/verify-deploy-backends.mjs`) deploys the same programs on each backend against a *fresh devnode per arm*, then drops the fields two independent chains can never agree on (`txId`, `blockHeight`, `deployedAt`, `updatedAt`, `feePaid`) and requires the remainder to match exactly, asserting `status: "complete"` and non-null `txId`/`blockHeight` separately. It is also the only place real-chain `--dry-run` purity is checked: the Leo arm dry-runs first, while the state directory is still empty, and fails if a transaction is missing or if anything was written.

Its two cases are chosen for the failures that are otherwise silent. `hello` also deploys `hello` renamed to `zhello` — whose id *contains* `hello.aleo`, so a broken closure subtraction trips the collision guard instead of quietly skipping the program being deployed. `multi-program` deploys `treasury` then `rewards`, which imports it, so a wrong skip list makes Leo save two transactions or none.

**Scale** (`scripts/verify-deploy-scale.mjs`) is the acceptance harness for the memory wall itself, on a generated fixture (`scripts/gen-large-program.mjs`). It runs with `--prove` because both backends take a devnode fast path that skips proof generation, and key synthesis is the only place the ceiling lives — without it the fixture deploys in seconds on both arms and proves nothing.

The fixture is **four heavy library programs plus a thin program that imports all four**, and that shape is the whole trick. snarkVM caps a *program* at 2,097,152 variables, which is well below where the SDK gives out — so no single program the chain accepts can separate the backends. But the SDK's ~4 GiB ceiling bounds a *deployment*, and a deployment's key material spans the entire import closure: the verifying key of every called function is re-synthesized from source, never read back from the chain. Each library stays far under the per-program cap while their sum does not.

Each arm gets a fresh devnode, and the libraries are deployed **with the Leo backend on both arms** — identical setup, not the thing under test. That does not tilt the comparison: the SDK has no on-disk key cache to have been primed, and it runs in its own process, so it re-synthesizes from source either way. Only `deploy --program scale_probe` is measured.

Measured on Leo 4.3.2 / snarkVM 4.8.1:

| arm | result | peak RSS (whole process tree) |
| --- | --- | --- |
| `leo` | deployed in 0.9m | 4.72 GB |
| `sdk` | never returned; killed at the 15m bound | 4.92 GB, flat from ~7m on |

Same program, same `--prove`, equivalent chains from the same genesis (each arm gets its own devnode), reproduced across runs — the SDK's peak lands between 4.76 and 4.92 GB and then stops moving.

**The two arms want roughly the same amount of memory. Only one of them is allowed to have it.** That is the whole result, and it is worth stating plainly because the numbers invite the wrong reading: Leo is not winning by being lean. It needs ~4.7 GB too — it simply asks the host for it, while the SDK is asking a 32-bit WASM linear memory whose ceiling is 4 GiB no matter how much RAM the machine has.

The `~/.aleo` cache explains the *time*, not the memory. The libraries' keys are on disk from their own deployments, so Leo loads them instead of re-deriving them and finishes in 54 seconds; a cold-cache Leo run would be far slower and still succeed. Both halves matter, and they are separate claims.

(RSS is sampled across the whole process tree. Sampling only the LionDen pid — as an earlier version of this harness did — reports ~0.65 GB for the Leo arm, because the real work is in the `leo` child. That number was wrong and produced exactly the "fast and small" misreading above.)

Both arms are asserted, and the assertions are deliberately narrow. The Leo arm must exit 0, not time out, *and* leave a complete record — writing the record and then dying is not a pass. The SDK arm must fail the specific way the wall fails: it has to not return at all (or be killed by `SIGABRT`/`SIGKILL`, how an exhausted allocator dies) **and** peak above 3 GB. A clean non-zero exit, or a failure at 200 MB, fails the lane instead of being recorded as the memory wall. The 15-minute bound is roughly 3x a successful SDK run of comparable size, so the result is not an artifact of an impatient timeout.

`--shape wide` (one program at the largest size the chain accepts) is kept as a benchmark and asserts only the Leo arm: the SDK deploys it in ~5 minutes. See the measurement tables in `gen-large-program.mjs` and [`testing-strategy.md`](testing-strategy.md#tier-4-proof-and-compatibility-tests).

## Where To Go Deeper

- [`deployment.md`](deployment.md) — deployment state, records, preflight, recipes, hooks.
- [`leo-version-compatibility.md`](leo-version-compatibility.md) — the wider Leo support range and what LionDen invokes.
- [`network.md`](network.md#provable-sdk-integration) — the SDK adapter and egress policy.
- [`testing-strategy.md`](testing-strategy.md) — tier taxonomy and CI lanes.
