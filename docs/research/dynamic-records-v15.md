# Dynamic Records And V15 Record Existence

This note explains the snarkVM V15 record-existence rule for Leo v4 `dyn record`
flows. It is practical maintainer guidance for authoring compliant programs and
for understanding LionDen's dynamic-record example. For client-side id-only
output handling, matchers, and decryption APIs, see
[`network.md` § Id-only record outputs](../network.md#id-only-record-outputs-dyn-record-and-external-record).

## When To Read This

Read this when working on:

- Leo v4 `dyn record` inputs or outputs.
- Dynamic dispatch through interface calls such as `TokenStandard@(target)::transfer(...)`.
- V15 errors like:

  ```text
  Non-static record input at r<reg> of the root function <prog>/<fn>
  is not known to correspond to a record on the ledger
  ```

- `IdOnlyDynamicRecordHandle` recovery, when you need to know why a sibling
  concrete record output must exist.
- The `examples/aleo-ports/dynamic_records` programs, config, tests, or
  generated typechain.

This page is about consensus and Leo program shape. Use `docs/network.md` for
the TypeScript API surface that selects and decrypts id-only dynamic/external
record outputs.

## Core Rule

V15 treats a root `DynamicRecord` or `ExternalRecord` input as a non-static
record input. A non-static root input is valid only if the same execution
connects that value to a static record consume.

There are two separate obligations:

- **Global obligation:** every root non-static record input must materialize
  through a connected static `Record` consume somewhere in the same execution.
  Reading fields from a `dyn record`, returning it, or forwarding it only as
  another `dyn record` does not materialize it.
- **Local obligation:** if a function mints a static record locally, casts it to
  `dyn record`, and then outputs or passes the dynamic value, it must also
  output the concrete static record. The dynamic handle alone is not a ledger
  record.

The bright line is the execution boundary. One execution callgraph can pass
dynamic values internally, including through routers, as long as the flow
eventually connects to a concrete-record-typed callee where required. A dynamic
value carried across transactions is only a view. It is not the spendable
record ciphertext, and it does not give the next transaction a serial number or
ledger commitment to spend.

## Why The Rule Exists

`record_dynamic` and external-record ids do not carry the data that makes a
record spendable on the ledger. They do not include:

- a record commitment,
- an inclusion proof, or
- a serial number/nullifier.

Without V15's materialization rule, a program could read fields from a fabricated
or already-spent dynamic/external record and mint real value from those fields.
The rule closes the gap by requiring a real static-record consume when a
non-static root input crosses into an execution.

The main V15-rejected patterns are:

| Pattern | Why it is unsafe |
| --- | --- |
| Root `dyn record` or external record is read but never consumed as static | Counterfeit or replayed fields can drive real state/value changes. |
| A locally minted record is returned only as `dyn record` | The dynamic output has no ledger commitment, so it is an unbacked handle. |
| A locally minted static record is passed to a callee but not output | The callee can act on a record the caller never committed. |
| A dynamic cast of a locally minted record is passed to a callee but the static record is not output | Same phantom-record problem, hidden behind the dynamic view. |
| A closure emits record-like values | Closures are inlined and do not provide the transition boundary the checks rely on. |

## Authoring Patterns

Use concrete records for authoritative spends:

```leo
interface TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        ..
    }

    fn transfer(token: Token, to: address) -> (Token, dyn record);
}

program gold_token.aleo : TokenStandard {
    record Token {
        owner: address,
        amount: u64,
        purity: u64,
    }

    fn transfer(token: Token, to: address) -> (Token, dyn record) {
        let new_token: Token = Token {
            owner: to,
            amount: token.amount,
            purity: token.purity,
        };
        return (new_token, new_token as dyn record);
    }
}
```

The input `Token` is a concrete record consume. Under dynamic dispatch, a router
can still pass a `dyn record` operand to this callee; because the callee's
declared input type is concrete, the execution materializes the root dynamic
input through the spend. Returning `(Token, dyn record)` also satisfies the local
obligation by committing the concrete sibling output alongside the dynamic
handle.

When a dynamic tuple return is not accepted by the Leo version in use, the
fallback is to return concrete records only and keep `dyn record` off the spend
function output.

Use `dyn record` on polymorphic routing surfaces:

```leo
program token_router.aleo {
    fn route_transfer(
        token_program: identifier,
        token: dyn record,
        to: address,
    ) -> dyn record {
        let result: (dyn record, dyn record) =
            TokenStandard@(token_program)::transfer(token, to);
        return result.1;
    }
}
```

The router can accept `dyn record` because it forwards that value to a
concrete-record-typed `transfer` implementation in the same execution. A router
that only reads `token.amount` and returns/mints from it without a static
consume is not V15-valid as a root transaction.

This satisfies the structural `ensure_records_exist` check. Held records also
need their original plaintext metadata preserved by the client to reconstruct
the correct ledger commitment; see [Held records and inclusion
proofs](#held-records-and-inclusion-proofs-verify-vs-prove). A root `dyn record`
forwarded into a concrete consume can prove for a record minted by an earlier
transaction as well as one produced inside the same execution.

`balance_of` is a read, and the rule turns on whether its input is a *root*
record. The natural shape is a pure read:

```leo
fn balance_of(token: dyn record) -> u64 {
    return token.amount;
}
```

This is V15-valid only when the `dyn record` it reads is produced *inside* the
execution — for example a `mint` or `transfer` output that never crosses the root
boundary. Called directly on a held token (a root `dyn record` input), it is
rejected, because nothing in the execution consumes that input as a static
record:

```text
Non-static record input at r0 of the root function gold_token.aleo/balance_of
is not known to correspond to a record on the ledger
```

If you need a balance read that *is* directly root-callable on a held token, the
only V15-valid shape consumes and reissues the token — a real UTXO spend, not a
free view:

```leo
fn balance_of(token: Token) -> (Token, u64) {
    let reissued_token: Token = Token {
        owner: token.owner,
        amount: token.amount,
        purity: token.purity,
    };
    return (reissued_token, token.amount);
}
```

LionDen's example uses the pure read and keeps it off the root boundary (see
below). This matches the ARC-20-style split: concrete records are used for
authoritative spends, while `dyn record` belongs on read/routing surfaces that
either forward into a concrete consumer or operate on records produced inside the
execution.

## Held Records And Inclusion Proofs (Verify Vs Prove)

The `ensure_records_exist` rule above is a *verify-time, structural* check: it
asks whether every non-static root record input connects to a static consume in
the same callgraph. Passing it is necessary but **not sufficient** to actually
execute a spend. Spending a record additionally requires a *prove-time*
**ledger-inclusion proof**: snarkVM must show the consumed record's commitment is
present in the ledger's record tree (the SDK fetches it via
`GET /statePaths?commitments=<cm>`).

A record's commitment depends on its original program, record name, and
plaintext metadata. LionDen's generated concrete deserializer stores the exact
decrypted plaintext under the non-enumerable `BaseContract.RECORD_RAW` symbol.
Generated dynamic helpers now preserve that plaintext too, including `_version`
even when it is absent from the ABI and configured schema. Manually constructed
inputs still use schema encoding, but they can now carry `_version` when the
helper schema declares `_version: "u8.public"`. Pass the original decrypted
object: object spread, `structuredClone`, and JSON round-trips drop the
non-enumerable cache.
To persist a held record, store the plaintext string from `serialize<Record>`
(or the ciphertext) and rehydrate it through `deserialize<Record>` or
`decrypt<Record>`, which re-attach the cache. As with concrete serializers,
cached plaintext takes precedence over object fields.

Before this fix, generated dynamic helpers rebuilt only schema fields and
dropped `_version: 1u8.public`. The SDK interpreted the versionless literal as
version 0, reconstructed a different commitment, and failed during proving:

```text
GET /testnet/statePaths?commitments=<cm> -> 500
Commitment '<cm>' does not exist
```

An isolated two-program probe on Leo 4.3.2 and SDK/WASM 0.11.9 established the
cause: the failing request exactly matched the commitment computed from the
versionless helper literal, while the actual ledger commitment matched the
original plaintext and had a retrievable state path. Passing the original
plaintext through the same held-root router produced an accepted transaction
with a nonempty proof. The earlier claim on this page that a different-program
dynamic root inherently loses the originating program binding was incorrect.

The devnode fast path skips inclusion-proof generation, so it did not detect
this client serialization defect. Both `route_transfer` and
`dispatch_and_receipt` now require success in both modes; their proving tests
also inspect the confirmed execution receipt for a nonempty proof. A green
no-proof test alone is still insufficient evidence of inclusion-proof support.
Preserving metadata does not waive the structural concrete-consume obligation
or make an id-only dynamic output into a spendable record.

## LionDen Example And Typechain Surface

`examples/aleo-ports/dynamic_records` is the canonical LionDen example for this
rule. It combines runtime dynamic dispatch, Leo v4 `dyn record`, V15-compliant
record materialization, and the matcher-based id-only output API.

In that example:

- `gold_token.aleo` and `silver_token.aleo` implement `transfer(token: Token, to)
  -> (Token, dyn record)`. Direct token wrappers therefore consume concrete
  `TokenInput` values.
- `balance_of(token: dyn record) -> u64` is a pure read. It is exercised only on
  dynamic records produced inside the execution: the router's read functions and
  `external_token_demo::issue_receipt` `mint` a token first, then read it. A
  direct/root `balance_of` on a held token is rejected by V15 — a negative test
  (`direct balance_of on a held token is rejected by the V15 record-existence
  check`) asserts the exact error.
- `token_router.aleo` forwards `dyn record` values into the concrete
  `TokenStandard@(token_program)::transfer(...)` callee. `demo_transfer` mints
  internally; `route_transfer` accepts a held token from an earlier transaction.
  Both are tested for acceptance. `external_token_demo::dispatch_and_receipt`
  tests the held-root shape with a concrete receipt output. Read functions
  (`read_balance`, `gold_beats_silver`, `has_more`) mint internally before
  calling the pure `balance_of`.
- Typechain helpers such as `asGoldToken(token)` and `asSilverToken(token)` turn
  a typed concrete token object into a `dyn record` input for router/external
  wrapper calls.

Dynamic outputs surface as `IdOnlyDynamicRecordHandle`. This recovery pattern:

```ts
const transferred = await accepted.outputs
  .match(asGoldToken.output.from("transfer", 0))
  .decrypt(key);
```

is explicit sibling-record recovery. It selects the concrete `Token` emitted by
the `gold_token.aleo/transfer` callee at output index `0`. It does not
dereference the dynamic-record id, because the id has no ciphertext to decrypt.

## Metadata-Fix Verification (2026-09-08)

Verified on Leo 4.3.2 with SDK/WASM 0.11.9 (the version resolved by this
repository's lockfile) and the fixed generator:

- The codegen unit, runtime, golden, and typecheck suites pass. The two
  version-preservation regression tests fail against the old generator and pass
  with the fix.
- The full `dynamic_records` example passes without proving (24 tests).
- A focused proving run of `route_transfer` and `dispatch_and_receipt` with held
  records passes (2 tests). Both check the confirmed receipt for a nonempty
  execution proof. The remaining example tests were not rerun with proving.

After rebuilding `@lionden/leo-compiler` and compiling the example, run from the
example directory:

```bash
npm test -- --network devnode --no-compile --prove=false
npm test -- --network devnode --no-compile --prove --grep 'with a held record' --timeout 1800000
```

This evidence is devnode acceptance with a nonempty proof. It was not confirmed
against a public network, so treat it as verified for the stack above rather than
as a general guarantee.

## Source Appendix

Primary upstream references for the rule and surrounding feature:

- snarkVM PR #3173, "Ensure records exist":
  <https://github.com/ProvableHQ/snarkVM/pull/3173>
- snarkVM issue #2667, "Don't allow unchecked External Records":
  <https://github.com/ProvableHQ/snarkVM/issues/2667>
- snarkVM `ensure_records_exist.rs`:
  <https://github.com/ProvableHQ/snarkVM/blob/fad09d8ba/synthesizer/process/src/verify_execution/ensure_records_exist.rs>
- snarkVM dynamic dispatch PR #3062:
  <https://github.com/ProvableHQ/snarkVM/pull/3062>
- Leo interfaces and dynamic dispatch overview:
  <https://provable.com/blog/interfaces-and-dynamic-dispatch-in-leo>
- Leo documentation:
  <https://docs.leo-lang.org/>
- Leo dynamic-dispatch related PRs:
  <https://github.com/ProvableHQ/leo/pull/29296>,
  <https://github.com/ProvableHQ/leo/pull/29298>,
  <https://github.com/ProvableHQ/leo/pull/29249>
- ARC-0020 Token Standard discussion:
  <https://github.com/ProvableHQ/ARCs/discussions/124>

This page intentionally does not list live network activation heights; re-check
upstream consensus-height tables when that operational detail matters.
