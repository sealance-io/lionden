---
"@lionden/core": minor
"@lionden/plugin-deploy": minor
---

Implement the **Leo CLI deploy backend** for `deploy`, on devnode networks.
`--deploy-backend leo` now builds real deployment transactions by invoking the
Leo CLI, instead of failing with "not implemented yet".

**Why this exists.** The Provable SDK builds a deployment in one monolithic WASM
operation, synthesizing and retaining proving keys for every function, record
circuit and uncached import until it completes. Large programs can exhaust
WASM's ~4 GiB limit during key setup and hang before control returns to
JavaScript, so the SDK cannot persist partial progress or resume. The Leo CLI
caches synthesized keys under `~/.aleo`, so a failed or timed-out run resumes
cheaply. This is a capability gap, not a preference — `capabilities.resumableKeySynthesis`
is the flag that records it.

**Leo builds; lionden broadcasts.** The backend runs `leo deploy --save` without
`--broadcast` and hands the resulting transaction back, so dependency ordering,
pending markers, deployment records, confirmation polling and hooks all stay
exactly where they were. The saved file is a bare snarkVM transaction and is
broadcast byte for byte.

**Scope.** Devnode only, and `deploy` only. `upgrade` and HTTP networks are
refused with a clear message and remain on the SDK backend for now — HTTP has
security prerequisites that ship with it. Fee estimation returns the existing
`FEE_ESTIMATION_UNAVAILABLE` warning rather than an estimate; the SDK path is no
better there, since `estimateDeploymentFee` synthesizes keys and hits the same
memory wall as the deploy it is estimating.

**Correctness guards**, each covering a way the Leo CLI can quietly do the wrong
thing:

- **Exit code 0 never means success.** Leo exits 0 when `--skip` matches every
  program, and also when a broadcast transaction is rejected on chain. Success
  is never inferred from the exit code: it requires the expected
  `<program-id>.deployment.json` to exist *and* to validate (see below). A run
  that produces more than one transaction is rejected too.
- **`--skip` collisions are refused up front.** Leo matches skips by substring,
  so a dependency `hello.aleo` would also suppress a target named
  `renamed_hello.aleo` — a silent no-op deployment. The check names both ids.
- **The package is hashed before and after the run.** `leo deploy` recompiles
  from `src/` when `src/` is newer than `build/`, and overwrites `build/` when
  it does. If the compiled program changes during the run, the transaction is
  discarded **before broadcast** rather than recorded under bytecode lionden
  never built.
- **The Leo binary's version is checked independently.** `skipLeoVersionCheck`
  does not relax it and `--noCompile` does not skip it, because both otherwise
  let a 3.5 or 4.1 binary reach a 4.3-only flag surface.
- **The saved transaction is validated, not just named.** The file name is Leo's
  label for the blob; the bytes are parsed and checked to be a deployment
  transaction declaring the requested program before anything is broadcast or
  recorded. An empty or truncated write, or a stale file under the right name,
  is refused. The original bytes are broadcast unchanged — never re-serialized.

**Security.** The signing key is passed through the child environment and never
in argv, so it stays off the process list. `DEVNET` is always assigned an
explicit `true`/`false` rather than deleted — deleting it lets a stale
`DEVNET=true` in a materialized package's `.env` win, which would run a real
network deployment in devnet mode. Transactions are saved to a `0o700` temporary
directory outside `artifacts/`, removed in a `finally`.

**`@lionden/core`** gains `redactSecrets` and `createStreamRedactor`, plus the
existing `parseLeoVersionOutput` is now exported. Every byte of Leo's output
that reaches the user — forwarded stdout, the buffered tail, and the tail
embedded in error messages — passes through the stream redactor first. It is a
small state machine rather than a windowed regex because a private key split
across chunk boundaries matches no per-chunk pattern, and the key grammar has no
upper bound, so no fixed carry-over window is provably safe. Leo's own truncated
rendering — `APrivateKey1zkp8CZNn3yeC...`, the first 24 characters of the signing
key, printed in its deployment plan summary — is redacted too; it is 12
characters of real key material and is far too short to trip the length-based
rule, so the trailing ellipsis is what identifies it.
