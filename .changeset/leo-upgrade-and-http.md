---
"@lionden/leo-compiler": minor
"@lionden/plugin-deploy": minor
---

Extend the **Leo CLI deploy backend** to `upgrade` and to HTTP networks, and stop
writing real private keys into materialized Leo packages.

**`upgrade` on the Leo backend.** `leo upgrade` takes the same flag surface as
`leo deploy` — down to `--skip`, whose help text differs only in the verb — so
both operations run the same invocation path: `--save` without `--broadcast`,
lionden broadcasts, and the pending marker, edition bookkeeping, confirmation
polling and `programUpgraded` hook all stay where they are. Leo derives the new
edition itself; there is no `--edition` flag and nothing about lionden's
`previousEdition` bookkeeping changes.

`upgradeAction` now resolves the program's **local dependency closure**, which
it previously had no reason to compute. `leo upgrade` upgrades a package's whole
local closure by default, so every dependency has to be named in `--skip` for
lionden to keep owning one program per invocation. The traversal roots at the
**source** program id and subtracts the **source** id — not the effective
post-rename one. Subtracting the effective id would be a no-op, because the
post-rename id is not a node in the source graph, and would leave the source id
in the skip list; since Leo matches skips by substring, `--skip hello.aleo` also
suppresses `renamed_hello.aleo`, so the run would exit 0 having upgraded
nothing.

**HTTP networks.** Both operations, and `--dry-run`, now work against a real
network. The Leo backend can dry-run where the SDK cannot: `--save` without
`--broadcast` builds a transaction and hands it back, while the SDK's HTTP path
builds and broadcasts as one atomic operation. Two devnode-only flags are
omitted on HTTP — `--devnet`, and `--skip-deploy-certificate`, which substitutes
placeholder certificates and verifying keys that a real network rejects.

**Security: no private key on disk for HTTP networks.**
`materializePackage` wrote `PRIVATE_KEY=<the network's real key>` into
`<artifacts>/.build/<id>/.env`. That is a live credential at rest inside the
build output — routinely archived, copied into containers and shared — and
nothing needs it there: `leo build` signs nothing, and the deploy backend
supplies a key through the child environment. The line is now omitted entirely
for `type: "http"` networks, including the devnode placeholder that a keyless
HTTP network used to get. The placeholder stays for devnode networks; it is the
well-known key Leo publishes in its own `--help`.

**Security: Leo is never left to pick the signing identity.** Leo resolves
`PRIVATE_KEY` from a `.env` file in its working directory and every parent of
it — the project root, not the materialized package, which it does not consult
for this. So clearing the variable from the child environment is not "no key",
it is "whatever key is on disk", and a deployment signed by an identity lionden
never selected succeeds under the wrong account. The Leo backend now refuses to
spawn at all when neither `networks.<n>.privateKey` nor a `deployer`/`admin`
named account supplies one, naming both in the error.

`DEVNET` is pinned to a literal `true`/`false` for the same reason. A project
`.env` carrying `DEVNET=true` from local devnode work would otherwise win on an
unset variable and send a real-network deployment out in devnet mode; `--devnet`
is a valueless flag with no negative form, so an explicit `DEVNET=false` is the
only way to force it off. `NETWORK` and `ENDPOINT` are pinned likewise.

**`--dry-run` no longer claims to be devnode-only.** The rejection named a
connection type, which was accurate only while the Leo backend was devnode-only.
It now names the backend that cannot build without broadcasting and points at
`--deploy-backend leo`, which can, on any network. The `deploy --dryRun` help
text says the same.
