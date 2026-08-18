# Leo CLI deploy/upgrade captures

Verbatim recordings of `leo deploy` and `leo upgrade` runs against a local
devnode, captured to pin down the Leo CLI's actual output contract before the
Leo deploy backend is written against it. The analysis these captures support is
in [`docs/research/leo-cli-deploy-backend-spike.md`](../../../../../docs/research/leo-cli-deploy-backend-spike.md).

These are inert test inputs. They live under `__fixtures__` so Biome leaves them
byte-exact (`biome.jsonc` excludes the directory from both formatting and
linting) — reformatting the JSON would destroy the thing being asserted.

## Provenance

| | |
| --- | --- |
| Leo | `4.3.2 (60bbdef HEAD) features=[noconfig]` |
| Network | `testnet` on `leo devnode start`, consensus version 17 |
| Signer | devnode account 0, `aleo1rhgdu77hgy…` — the published local-devnet key |
| Captured | 2026-08-18 |

## Layout

Each deploy/upgrade case directory holds the full record of one invocation:

| File | Contents |
| --- | --- |
| `argv.txt` | the exact command line, shell-quoted |
| `exit-code.txt` | Leo's exit status |
| `stdout.txt` / `stderr.txt` | untouched streams |
| `json-output.json` | the `--json-output=<file>` artifact, when one was written |
| `save/` | the `--save <dir>` artifacts, when any were written |
| `save-listing.txt` | the save directory's contents — the only way to record an *empty* save directory, which git cannot track and which is itself the observation in `deploy-skip-all` |
| `observation.txt` | present only on the two rebuild cases; records the `build/` hashes before and after |

Two directories are not deploy runs and have a different shape:

- `environment/` — `leo --version`, the full `leo deploy --help` and
  `leo upgrade --help` option surfaces, and `api-key-scan.txt`, the evidence for
  the claim that Leo cannot authenticate its endpoint queries.
- `broadcast-verbatim/` — the round trip proving a `--save` artifact is
  broadcastable unmodified: the file, a precondition check that the program was
  *not* already on chain, the POST, the response, and on-chain confirmation.

## The one edit

Leo echoes absolute `--save` paths into stdout. Committing those would bake one
machine's directory layout into a fixture, so the capture root and the home
directory were replaced with `<SPIKE_ROOT>` and `<HOME>`. Nothing else was
changed: no reformatting, no trailing-newline normalisation, and the truncated
private key Leo prints in its plan summary is left in place because the
redaction design has to account for it.

## Cases

| Directory | Exit | What it pins down |
| --- | --- | --- |
| `deploy-single` | 0 | baseline `--save` + `--json-output` shape |
| `deploy-multi` | 0 | three deployments, emitted in dependency order |
| `deploy-skip-one` | 0 | `--skip` of a non-colliding dependency |
| `deploy-skip-collision` | 0 | `--skip spike_a.aleo` **also** drops `zspike_a.aleo` |
| `deploy-skip-all` | 0 | everything skipped: empty save dir, `"deployments": []`, still exit 0 |
| `deploy-fee-estimate` | 0 | neither `--save` nor `--broadcast`: same JSON, transaction still built |
| `deploy-broadcast-confirmed` | 0 | `--broadcast` adds a nested `broadcast` object |
| `deploy-network-dep` | 0 | a `location: "network"` dependency is not a deployment candidate |
| `deploy-deps-already-onchain` | 0 | Leo re-builds deployments for deps that are already live |
| `deploy-with-certificate` | 0 | same run without `--skip-deploy-certificate`; adds four constraint fields to `stats` |
| `deploy-rebuild-build-current` | 0 | `build/` current: deploy leaves it byte-identical |
| `deploy-rebuild-src-changed` | 0 | `src/` newer: deploy silently recompiles and overwrites `build/` |
| `deploy-endpoint-unreachable` | 213 | `--save` needs a reachable endpoint; no `--json-output` file is written |
| `deploy-endpoint-unreachable-consensus-pinned` | 248 | pinning `--consensus-version` does not remove that requirement |
| `upgrade-save` | 0 | upgrade output is shaped exactly like deploy, at `edition: 1` |
| `upgrade-rejected-by-constructor` | 0 | on-chain rejection still exits 0, and `broadcast` is absent entirely |

## About `programs/`

`programs/` is the **final state** of each Leo package, not a per-case snapshot.
Several cases were deliberately captured against earlier revisions — the rebuild
and upgrade cases only mean anything because the source changed between runs —
so this snapshot does **not** reproduce the corpus as committed. `spike_a` and
`spike_up` each went through several revisions; `zspike_a`, `spike_main` and
`spike_net` never changed.

The authoritative program for any given case is the compiled
`deployment.program` inside that case's save file, with the transition list also
visible in `json-output.json` under `stats.function_costs[].name`. Derived from
those, the revision each case used:

| Package | Revision | Cases |
| --- | --- | --- |
| `spike_a` | `bump` | `deploy-single`, `deploy-multi`, `deploy-skip-one`, `deploy-fee-estimate` |
| `spike_a` | `bump`, `reset` *(final)* | `deploy-deps-already-onchain`, `upgrade-rejected-by-constructor` |
| `spike_up` | `put` | `deploy-broadcast-confirmed` |
| `spike_up` | `put`, `clear` | `upgrade-save` (edition 1) |
| `spike_up` | `put`, `clear`, `probe` | `deploy-rebuild-build-current` |
| `spike_up` | `put`, `clear`, `probe`, `touch` *(final)* | `deploy-rebuild-src-changed` |
| `zspike_a` | `accrue` | all |
| `spike_main` | `drive` | all |
| `spike_net` | `pay` | all |

What `programs/` *is* good for: the package layout, the dependency declarations
in `program.json`, and the naming. `spike_a.aleo` is a strict substring of
`zspike_a.aleo` on purpose — that is what makes the `--skip` collision case
meaningful.
