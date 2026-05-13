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

`ctx.raw.execute(...)` accepts the same `options.imports?: readonly string[]` surface as the typed wrappers — useful when an escape-hatch call needs to load dynamic-dispatch targets (program ids or local `.aleo` paths) that the dispatching program doesn't `import` statically. See [`network.md` § Runtime Imports For Dynamic Dispatch](network.md#runtime-imports-for-dynamic-dispatch) for the full model.

`ctx.execute(...)` and `ctx.raw.execute(...)` await on-chain confirmation by default and return the matching transition's parsed `outputs` (plus a faithful `rawOutputs` snapshot when the chain carries id-only dynamic-record entries). Pass `{ awaitConfirmation: false }` to recover fire-and-forget semantics — useful when broadcasting many transitions in parallel, or as the escape hatch for reentrant / recursive flows (see § `rawOutputs` Transition Identity).

`deploy()` checks the deployment manager cache before invoking the `deploy` task. This avoids redeploying a program already deployed in the same session and returns the cached complete `{ programId, txId }` when available. If the deploy task skips all targets, `deploy()` checks the cache again and returns only complete records with a `txId`; degraded or recovered records still throw because they cannot identify the original deployment transaction. Pass `{ noSkipDeployed: true }` when a fixture must fail instead of reusing or skipping an existing deployment. `teardown()` invalidates the deployment cache for the connected network so the next test context revalidates state against the active network. The `network` property on `TestContext` exposes the connected network name. `TestContext` structurally satisfies `DeploymentContext` from `@lionden/plugin-deploy`, so deployment recipes can be called directly from test fixtures without any explicit type casting.

`namedAccounts` is populated from `lre.namedAccounts` after `connect()`. It holds `{}` when no `namedAccounts` field is present in the project config — existing tests continue to work unchanged. New tests should prefer `ctx.named.signer(...)`, `ctx.named.address(...)`, or `ctx.named.require(...)` for required named-account roles.

## Devnode Lifecycle In Tests

`packages/testing/src/devnode-lifecycle.ts` wraps `DevnodeManager` for test suites.

Current behavior:

- derives defaults from the first configured devnode network when available
- starts a devnode unless the caller skips it
- verifies a manually supplied devnode is reachable up front when setup uses a devnode network but did not start one
- returns a managed handle with endpoint metadata
- tears it down during cleanup

`setup()` respects `config.testing.autoStartDevnode`.

Managed devnodes default to `logMode: "quiet-buffered"` — output is drained and ring-buffered (last 64 KiB per stream). Set `LIONDEN_DEVNODE_LOGS=inherit` to surface devnode logs to the test runner output without editing test code. See [`network.md`](network.md#devnode-log-mode) for the full log-mode contract and precedence rules.

## Test Runner Task

`packages/plugin-test/src/index.ts` exposes the `test` task.

Current flow:

1. run `compile` unless `--no-compile` is set
2. dispatch testing suite setup hooks
3. run Vitest through `packages/plugin-test/src/test-runner.ts`
4. dispatch testing suite teardown hooks

Current task options:

- `[files...]`
- `--grep`
- `--timeout`
- `--no-compile`
- `--prove`
- `--parallel`

`--prove` is forwarded through `LIONDEN_PROVE=true` so test execution can force proof generation.

Use `lionden test [files...]` to run a managed Vitest subset while keeping LionDen's compile step, suite hooks, and managed devnode lifecycle:

```bash
lionden test test/orders.test.ts
lionden test test/orders.test.ts test/tally.test.ts --grep orders
lionden test "test/**/*.integration.test.ts"
```

File and glob positionals are passed to Vitest as include patterns with the LionDen project root as Vitest's root. They are not resolved relative to the shell's current working directory. File positionals compose with `--grep`: the file/glob list limits the test files, then Vitest applies the test-name pattern inside those files.

LionDen does not currently prevalidate that each positional path exists. A typo such as `test/oders.test.ts` follows Vitest's no-match behavior; clearer no-matching-file UX is a future enhancement.

## Vitest Integration

The programmatic Vitest runner currently:

- sets `LIONDEN_PROJECT_ROOT` so worker processes can rediscover the project config
- scopes test discovery to `test/**/*.test.ts` by default, or to the provided `lionden test [files...]` include patterns
- applies timeout overrides from task args or config
- returns summarized pass/fail counts

Vitest remains a peer dependency of `@lionden/plugin-test`. Running `npx vitest` directly is still available, but it bypasses LionDen's compile step, testing hooks, and managed devnode lifecycle.

## Fixtures And Assertions

`@lionden/testing` re-exports helpers for:

- fixtures via `loadFixture()` and `clearFixtures()`
- mapping and transaction assertions
- balance assertions
- block-height assertions
- well-known devnode accounts

This lets test suites stay concise without reimplementing common network checks.

## Typed Broadcast Results

`.accepted(...)` returns `AcceptedTransition<TOutputs>`, `.settled(...)` returns the union `AcceptedTransition<TOutputs> | RejectedTransition`, and `.rejected(...)` returns `RejectedTransition`. The `outputs` field on `AcceptedTransition<TOutputs>` mirrors `.locally()`'s return shape with two substitutions driven by what the chain returns encrypted:

- **Record outputs** → `EncryptedRecord<RecordName>` handles with `decrypt(key): Promise<RecordName>`.
- **Private plaintext outputs** (Leo's default visibility) → `EncryptedValue<T>` handles with `decrypt(key): Promise<T>`.
- **Public plaintext outputs** → decoded eagerly via the same deserializers used by `.locally()`.

`AcceptedTransition<TOutputs>` also carries `transitionPublicKey: string` — the on-chain `tpk` needed by the SDK to decrypt private value ciphertexts. It's threaded through `EncryptedValue<T>.decrypt(...)` automatically; callers don't pass it directly. `RejectedTransition` has no `outputs` and no `transitionPublicKey` (fee-only inclusion carries neither).

```ts
// Single record output → outputs is an EncryptedRecord<Token>
const mintTx = await token.mint_private.accepted({ receiver, amount: 100n });
const mintedRecord = await mintTx.outputs.decrypt(ctx.accounts[0]);
await token.transfer_private.locally({ token: mintedRecord, ... });

// Multi-output (Token, bigint) → outputs is a positional tuple
const swap = await amm.swap.accepted({ ... });
const [encryptedToken, leftoverAmount] = swap.outputs;
const decoded = await encryptedToken.decrypt(ctx.accounts[0]);

// Private plaintext output: u64 without `public` modifier → EncryptedValue<bigint>
const compare = await governance.compare_strategies.accepted({ balance: 10000n });
const [linear, quadratic] = compare.outputs;
expect(await linear.decrypt(ctx.accounts[0])).toBe(10000n);
expect(await quadratic.decrypt(ctx.accounts[0])).toBe(100n);
```

`rawOutputs: readonly RawTransitionOutput[]` is still available alongside `outputs` on every settled result. String entries carry the raw on-wire values from the specific transition the caller invoked (record ciphertexts, value ciphertexts, plain literals — whatever the chain returned). Id-only dynamic-record outputs are preserved in position as `{ kind: "idOnly", id, type }` entries, so ABI-indexed projectors do not shift later outputs.

### Why private plaintext outputs need `decrypt`

Aleo encrypts every non-`public` transition input and output on chain. The local SDK gives `.locally()` decoded plaintexts, but `.accepted()` / `.settled()` see the raw chain shape: `record1...` for record outputs, `ciphertext1...` for private plaintext outputs. `EncryptedValue<T>` wraps the value ciphertext + the per-output context (tpk, program, function, AVM global index) so a single `decrypt(key)` call drives `Ciphertext.decryptWithTransitionInfo(...)` under the hood. Public plaintext outputs are not encrypted on chain, so they're decoded eagerly with no `decrypt` hop.

### Future-typed Outputs

`outputs` carries only client-decodable transition outputs. Future-typed outputs (post-finalization values) appear in `rawOutputs` at their original ABI index but are not represented in the typed `outputs` projection. To inspect a Future output, read `rawOutputs[i]` at its original ABI index — the projector preserves positions, so an output at ABI index 1 always wraps `rawOutputs[1]` even if a Future occupies index 0.

### `EncryptedRecord<T>` / `EncryptedValue<T>` Decryption Keys

Both handles' `.decrypt(key)` accept the same polymorphic key shape (aliased as `DecryptionKey` for clarity, identical to `RecordDecryptionKey`): a raw `APrivateKey1...` / `AViewKey1...` string (auto-detected by prefix), `{ viewKey }`, or `{ privateKey }`. Lionden `SignerInput` and devnode account objects (`{ privateKey, address }`) structurally match the `{ privateKey }` arm. Unrecognized strings throw `RecordDecryptionKeyError`. SDK / ciphertext failures throw `LocalRecordDecryptionError` (records) or `LocalValueDecryptionError` (values) — keeping the error name aligned with the decryption phase.

For workflows that need to defer decryption — pass the ciphertext between processes, decrypt under a different account, batch decrypts — read `mintTx.outputs.ciphertext` directly and call `decrypt<RecordName>(ciphertext, key)` (records) or `decryptValueCiphertext(ciphertext, viewKey, tpk, programId, transitionName, globalIndex)` (values) later. The free `decrypt<RecordName>` functions remain generated alongside the typed projection.

### `rawOutputs` Transition Identity

`rawOutputs` is filtered from the confirmed transaction's `transitions[]` by `(programId, transitionName)` match:

- **Accepted**: exactly one matching transition is required. 0 or >1 throws `TransactionShapeError` so test assertions don't pick the wrong outputs from a cross-program tx. Reentrant or recursive flows must opt out of the default await and inspect transitions directly — pass `{ awaitConfirmation: false }` to `ctx.raw.execute(...)` and call `ctx.connection.waitForConfirmation(txId)` to walk `transitions[]` yourself (or use `ctx.connection.getTransitionOutputs(...)` for a single targeted transition by `(programId, transitionName)`).
- **Rejected**: Aleo converts rejected executes to fee-only on inclusion, so `rawOutputs` is typically `[]`. The selector stays permissive — if a matching transition entry IS present, its outputs are surfaced; if multiple match, the first is picked. This preserves `.rejected()` semantics for finalizer failures.

`RejectedTransition` does not carry an `outputs` field — fee-only inclusion has no typed-output projection to project.

### Error Policy For Typed Projection

`.settled()` and `.accepted()` wrap their typed projector with a narrow error policy:

- `TransactionShapeError` thrown by the projector (from `BaseContract.rawOutputAt`, which validates per-index access) is **rethrown unchanged**, preserving the `outputIndex` context.
- Any other error from the projector — including `TransitionInputError` from per-primitive parsers and native `Error` — is **wrapped as `TransactionShapeError` with `.cause` set** to the original. This keeps "bad on-chain data" failures classified as shape errors rather than misleading the caller that they provided bad input.

For `EncryptedValue<T>.decrypt(key)` specifically: only `RecordDecryptionKeyError` (caller-input shape) passes through unwrapped. SDK failures, malformed-ciphertext rejections from the SDK, and deserializer failures (even other `LionDenTypechainError` subclasses) wrap as `LocalValueDecryptionError` with `outputIndex` populated. This narrow pass-through makes "wrong account" / "malformed plaintext" failures surface under a single phase-aligned error name.

## Building Dynamic Records (Leo v4 `dyn record` Inputs)

For transitions whose Leo signature accepts `dyn record`, build the input with `Leo.dynamicRecord(value, schema)`. The schema is compile-time-validated via a `${LeoPrimitiveType}.${LeoVisibility}` template-literal union:

```ts
const tokenInput = Leo.dynamicRecord(
  { owner: Leo.address(addr), amount: 100n, _nonce: Leo.group("0group"), _version: 0 },
  {
    owner: "address.private",
    amount: "u128.private",
    _nonce: "group.public",
    _version: "u8.public",
  },
);
await amm.add_liquidity.locally({ token: tokenInput, ... });
```

Values are range-checked at runtime (integer bit-widths, address prefix, etc.). Missing or extra keys vs. the schema throw `TransitionInputError` with the offending key listed. The raw string escape hatch `Leo.unsafe.dynamicRecord("{ owner: ... }")` remains available for pre-built literals.

For repeated conversions from a generated concrete record type, prefer a `codegen.dynamicRecords` helper such as `asGoldToken(token)` over retyping the schema at every call site. See [`json-abi.md` § Interface Conversion Helpers](json-abi.md#interface-conversion-helpers-codegendynamicrecords) and `examples/aleo-ports/dynamic_records`.

## Strategy And Design Direction

For the proposed repo-wide testing strategy, lane split, and rollout plan, use [`testing-strategy.md`](testing-strategy.md).

For the rationale behind the Vitest-based testing model, devnode-first assumptions, and known testing constraints, use [`vision-and-roadmap.md`](vision-and-roadmap.md). Use the testing package and example suites for current reality.
