# Leo CLI Deploy Backend: Spike Findings

When to read this: use this file before writing or reviewing the Leo deploy
backend. It records what `leo deploy` and `leo upgrade` actually do, measured
rather than inferred, and lists the places where the design assumptions turned
out to be wrong. For the resulting user-facing behaviour, use
[`../deployment.md`](../deployment.md).

Every claim here is backed by a capture committed at
`packages/test-internals/src/__fixtures__/leo-cli/`, and each finding names the
directory that demonstrates it. Sixteen of those are deploy/upgrade runs; the
remaining two cover the claims that are not about a run — `environment/` holds
the version, the full option surfaces and the API-key scan, and
`broadcast-verbatim/` holds the broadcast round trip. Leo
`4.3.2 (60bbdef HEAD)`, `leo devnode` on testnet, consensus version 17.

Note that `programs/` is the packages' *final* state and does not reproduce the
corpus: several cases were captured against earlier revisions on purpose. The
fixture README carries a per-case revision table derived from the captures.

## Summary

Six questions were meant to be answered before any backend code was written.
All six are answered. Two of them invalidate an assumption the design was
resting on, and three more findings surfaced that were not on the list.

| # | Question | Answer |
| --- | --- | --- |
| 1 | Is the saved file directly broadcastable? | **Yes**, verbatim — but the filename is not what we assumed |
| 2 | Can Leo authenticate against an API-key endpoint? | **No**, and there is no mechanism to add |
| 3 | Is `--skip` substring matching? Do network deps need skipping? | **Yes**; **no** — but already-deployed local deps do |
| 4 | Does `leo deploy --path` rebuild? | Only when `src/` is newer than `build/` — then silently |
| 5 | Exact `--json-output` structure | Recorded below; `broadcast` is nested, not flat, and `stats` has two shapes |
| 6 | Does `--save` need a reachable endpoint? | **Yes**, unconditionally |

## 1. The saved transaction is broadcastable verbatim

`<save>/<program_id>.deployment.json` is a bare snarkVM transaction:

```
{ type: "deploy", id, owner: { address, signature },
  deployment: { edition, program, verifying_keys, program_checksum, program_owner },
  fee: { transition, global_state_root } }
```

No wrapper, no envelope. Captured in `broadcast-verbatim/`: the program was
confirmed absent from the ledger first (so a later success could not be a
no-op), the file's exact bytes were posted to
`POST /<network>/transaction/broadcast`, the endpoint returned `200` with a
transaction id equal to the file's own `.id`, and the program was live one
second later. The broadcast design holds.

Two details the parser has to get right: the file has **no trailing newline**,
and `type` is `"deploy"` even for an upgrade — the only structural difference is
`deployment.edition` (`upgrade-save` shows `1`).

**Correction to the plan.** The plan assumed `<save>/<id>.deployment.json`
keyed by *transaction* id. It is keyed by **program id** — `spike_a.aleo.deployment.json`.
That is better for us (the filename is predictable before the run, so the
backend can name the file it expects instead of globbing), but any code written
against the transaction-id assumption is wrong. `--save` and `--json-output`
both being present is what lets a program id be paired with its transaction id.

## 2. There is no way to authenticate Leo's queries

Evidence in `environment/` — the two full help outputs plus `api-key-scan.txt`.

`leo deploy --help` and `leo upgrade --help` expose no API-key, header, or
authorization option; a case-insensitive grep for
`api.?key|authorization|bearer|header|token` matches **zero** lines in either.
The only endpoint-related options are `--endpoint`, `--network`,
`--network-retries`, `--consensus-version` and `--consensus-heights`. A scan of
the binary for `bearer|x-api-key|api[-_]?key` also returns **zero** matches:
there is no token plumbing to configure even if one wanted to.

A broad grep for `authorization` does hit 26 lines, but none of them is an
endpoint auth path, and the grep is not evidence either way — every Rust HTTP
stack statically embeds the standard header-name table, so `authorization` and
`proxy-authorization` appear in any binary that links one. The hits are that
table, proxy/git-clone Basic auth (`Proxy-Authorization: basic `,
`Authorization: Basic `), and snarkVM's unrelated domain use of the word, where
an *Authorization* is its pre-execution request object
(`Cannot compute the execution ID for an empty authorization.`).
`api-key-scan.txt` records all three groups verbatim.

This makes the `apiKey` rejection in `assertDeployBackendCompatible`
**permanent**, not a temporary gap. It should be documented as a standing
limitation of the backend, and the rejection message should not imply a future
fix.

## 3. `--skip` is substring matching, and the closure is narrower than assumed

Substring semantics are confirmed. `spike_main.aleo` depends on `spike_a.aleo`
and `zspike_a.aleo`; deploying with `--skip spike_a.aleo` produced **one** save
file, `spike_main.aleo.deployment.json` (`deploy-skip-collision`). The full
program id `spike_a.aleo` is a substring of `zspike_a.aleo`, so both were
dropped. The collision check in §5 of the plan is load-bearing, and matching on
the full `.aleo`-suffixed id does not save you.

Two further results narrow what has to go into the `--skip` set:

- **Network dependencies are never deployment candidates.** A package importing
  `credits.aleo` as `location: "network"` produced exactly one save file, its
  own (`deploy-network-dep`). `graph.networkDeps` do **not** need skipping.
- **Leo does not consult the chain.** With `spike_a.aleo` and `zspike_a.aleo`
  both already live, deploying `spike_main.aleo` still built deployment
  transactions for all three (`deploy-deps-already-onchain`). Under `--broadcast`
  two of those would be rejected. Deduplication against deployment state is
  entirely lionden's job — nothing in Leo does it.

Mechanically, repeating the flag (`--skip a --skip b`) works, and the variadic
`--skip <SKIP>...` is terminated by the next `--flag`, so emitting one value per
flag is safe.

## 4. `leo deploy` recompiles from `src/`, silently

Two runs against the same package (`deploy-rebuild-*`, each with an
`observation.txt` recording `build/` hashes before and after):

- `build/` current — deploy left every artifact **byte-identical**.
- `src/` edited after the last build — deploy **rewrote `build/`**, and the
  saved transaction contained the newly added transition.

So the §8 post-run hash check fires exactly when `src/` has diverged from
`build/`, which in a lionden run means something changed between `compile` and
`deploy`. That is rare, and it means the pre-run check can catch the common case
with a better message. It does not soften the post-run check: a hash change
means Leo built different bytecode than lionden is about to record, so it stays
a hard error that aborts before broadcast.

## 5. `--json-output` structure

```
{ config: { address, network, endpoint, consensus_version },
  deployments: [ { program_id, transaction_id,
                   stats: { program_size_bytes, max_program_size_bytes,
                            // the next four appear ONLY when the deployment
                            // certificate was generated, i.e. when
                            // --skip-deploy-certificate was NOT passed:
                            total_variables?, total_constraints?,
                            max_variables?, max_constraints?,
                            storage_cost, namespace_cost, synthesis_cost,
                            constructor_cost, priority_fee, total_cost,
                            function_costs: [ { name, finalize_cost,
                                                storage_cost, execution_cost } ] },
                   broadcast?: { fee_id, fee_transaction_id, confirmed } } ] }
```

Against the plan's guess: `config` also carries `address`; `constructor_cost`
was not listed; and `broadcast`, `confirmed`, `fee_id`, `fee_transaction_id` are
**not flat fields on the deployment** — they are a nested `broadcast` object
that is **absent entirely** when `--broadcast` was not passed. The file has no
trailing newline.

`stats` has two shapes. Twelve of the thirteen cases with a deployment omit
`total_variables`, `total_constraints`, `max_variables` and `max_constraints`;
`deploy-with-certificate`, the one run without `--skip-deploy-certificate`,
carries all four, positioned between `max_program_size_bytes` and
`storage_cost`. A parser that treats the certificate fields as required will
break on every devnode run, and one that treats the rest as optional is being
needlessly lax. `function_costs` entries are the same four keys in both shapes.

`deployments[]` follows dependency order (`deploy-multi`: `spike_a`,
`zspike_a`, `spike_main`), and is `[]` rather than absent when everything is
skipped.

Worth noting for PR 7: the fee-estimation shape is not a cheap path.
`--json-output` with neither `--save` nor `--broadcast` produced byte-identical
`stats` — because Leo builds the full transaction anyway and discards it. Fee
estimation costs a full build.

## 6. `--save` requires a reachable endpoint

Pointed at a dead port, `leo deploy --save` failed with exit **213** and
`Failed to get consensus version`, writing **no `--json-output` file at all**
(`deploy-endpoint-unreachable`). Supplying `--consensus-version 17` explicitly
did not help: it then failed at exit **248** fetching `/testnet/stateRoot/latest`
for the fee transition (`deploy-endpoint-unreachable-consensus-pinned`).

There is no offline build. The backend cannot be presented as one, and the
"missing `--json-output` file" case is a real failure mode the runner must
handle rather than treat as a parse error.

## Unlisted finding: exit code 0 does not mean success

This is the most consequential result and it was not one of the six questions.

An upgrade of a `@noupgrade` program — its constructor asserts `edition == 0`,
so edition 1 cannot be accepted — was broadcast, **rejected on chain**, and Leo
exited **0** (`upgrade-rejected-by-constructor`). stdout says
`Transaction rejected.` and `❌ Failed to upgrade program spike_a.aleo`, but the
process status is success and `stderr` is empty.

Worse, the `--json-output` for that run is shape-identical to a successful
build-only run: `program_id`, `transaction_id`, `stats`, and no `broadcast` key.
Nothing in the machine-readable output distinguishes *rejected on chain* from
*built but never broadcast*.

Three consequences for PR 4:

1. **Never infer success from the exit code.** The runner must verify the
   expected `<program_id>.deployment.json` files exist, one per program it
   expected to build.
2. `deploy-skip-all` is the same hazard without a failure: exit 0, empty save
   directory, `"deployments": []`. A backend that trusts exit status would
   report a successful deployment of nothing.
3. Because lionden always builds with `--save` and broadcasts itself, the
   ambiguity in the rejection case never reaches production code — but only as
   long as `--broadcast` is never emitted. That is one more reason the no-`extraFlags`
   decision matters.

## Two smaller observations

**Leo truncates the private key but does print it.** The plan summary shows
`Private Key: APrivateKey1zkp8CZNn3yeC...` — the first 24 characters. Truncated,
but a prefix is still a prefix, so the redaction work in PR 4 stands. Passing
the key via the `PRIVATE_KEY` environment variable kept it off argv throughout,
as intended.

**`--skip-deploy-certificate` changes the saved transaction's bytes but not its
shape.** The same program built with and without the flag produced identical
`verifying_keys` structure and identical lengths (`vk_len=1092`,
`cert_len=111`) — only the certificate content differs, so the *transaction*
parser needs no branch for it. This does **not** extend to `--json-output`,
whose `stats` object does change shape; see §5.

## What this means for PR 4

Blocking corrections, all of them cheap if made before the code is written:

- Name saved files by **program id**, not transaction id.
- Parse `broadcast` as an optional **nested object**.
- Make the four constraint fields in `stats` **optional** — they are present
  only when the deployment certificate was generated.
- Verify **file existence**, never exit status.
- Drop `graph.networkDeps` from the `--skip` set; keep already-deployed local
  deps in it, because Leo will not skip them on its own.
- Treat a missing `--json-output` file as an ordinary failure mode.
- Document the API-key rejection as permanent.

Nothing found here contradicts the backend's premise. The capability gap that
motivated it is intact: Leo builds each program's transaction separately and
caches under `~/.aleo`, which is exactly the resumability the SDK's monolithic
WASM path cannot offer.
