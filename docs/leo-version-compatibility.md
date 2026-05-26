# Leo Version Compatibility

## Supported Versions

| Version | Status | Scope |
|---------|--------|-------|
| Leo 4.0.x | Default, full support | All features including `lib.leo` library units |
| Leo 3.5.x | Supported | Deployable `main.leo` programs only |

## Leo v3.5 Support Scope

Leo v3.5.x programs can be compiled, deployed, upgraded, and executed through LionDen. Cross-program calls work. The full deploy and upgrade lifecycle is supported, including constructor validation and ABI compatibility checking.

**Not supported under v3.5:** `lib.leo` library units. Leo v3.5 hardcodes `src/main.leo` as the compilation entry point and cannot compile library-shaped packages. Projects using shared library units must target Leo v4.

## Configuration

A v3.5 project must set `leoVersion`; set `leoBinary` when the desired v3.5 binary is not the `leo` on `PATH`:

```typescript
import { defineConfig } from "@lionden/config";

export default defineConfig({
  leoVersion: "3.5.0",
  leoBinary: "~/.leo/bin/leo-3.5",
  // ...
});
```

- **`leoVersion`** — compatibility declaration, not a binary pin. Accepted stable patch versions are `4.0.x` (default line) and `3.5.x`.
- **`leoBinary`** — path to the Leo CLI binary that LionDen actually executes. Defaults to `"leo"` (resolved from `PATH`). Tilde (`~/`) is expanded to the user's home directory during config resolution, since `execFile`/`spawn` do not perform shell expansion.
- **`skipLeoVersionCheck`** — default `false`. When `true`, LionDen still verifies that `leoBinary --disable-update-check --version` runs successfully, but skips parsing and comparing the version output. The configured `leoVersion` must still be a stable `major.minor.patch` string.

Install both Leo versions side-by-side with `leo update --name v3.5.0` (available since Leo v3.2.0). The default `leo` on `PATH` remains v4; point `leoBinary` at the named v3.5 installation.

Before LionDen-managed compilation or devnode startup, LionDen runs the configured Leo binary with update checks disabled:

```bash
leo --disable-update-check --version
```

When version checking is enabled, the first stable `major.minor.patch` version in the output is compared against the configured `leoVersion` major/minor line. Patch drift is allowed: for example, `leoVersion: "4.0.0"` accepts a `leo 4.0.2` binary. Minor drift is not allowed unless `skipLeoVersionCheck: true` is set. Missing or inaccessible binaries always fail preflight.

## Devnode Consensus Heights

Constructor programs (ARC-0006: `@noupgrade`, `@admin`, etc.) require `ConsensusVersion::V9`. The Leo v4 devnode activates V9 by default. The Leo v3.5 devnode does not — constructor deploys fail with _"program uses syntax that is not allowed before ConsensusVersion::V9"_ unless `--consensus-heights` is passed.

LionDen exposes this as an explicit opt-in field on devnode network config:

```typescript
networks: {
  devnode: {
    type: "devnode",
    consensusHeights: "0,1,2,3,4,5,6,7,8",
  },
}
```

The value is comma-delimited block heights at which each consensus version activates (length = target version). LionDen does not default this field — it matches the Leo CLI's own default behavior. V4 projects do not need it. V3.5 projects deploying constructor programs must set it explicitly.

`consensusHeights` and `network` selection apply to the **Leo backend only**. The standalone `aleo-devnode` backend (`provider: "standalone"`) is TestnetV0-only with consensus heights compiled in, so it rejects a non-`testnet` `network` and any `consensusHeights`. See the backend-selection section of [`network.md`](network.md#devnode-lifecycle).

## Compatibility Matrix

| Scenario | Supported |
|----------|-----------|
| Compile v3.5 deployable program | Yes |
| Deploy v3.5 bytecode to v4-class devnode/network | Yes |
| v3.5 → v3.5 upgrade (same compiler) | Yes |
| v3.5 → v4 migration upgrade (`@admin` path) | Yes |
| v3.5 cross-program calls (slash-path syntax) | Yes |
| v3.5 `lib.leo` library units | No |

## Known Limitations

1. **`lib.leo` not supported.** Leo v3.5 cannot compile library-shaped packages. Projects needing shared library units must use Leo v4.

2. **`@admin` is the validated upgrade path.** The v3.5 → v4 migration upgrade was validated with `@admin` constructors. Other constructor types (`@checksum`, `@custom`) compile and parse correctly but have not been exercised in a full cross-version upgrade probe.

3. **`add` is a reserved opcode in v3.5.** A Leo function named `add` conflicts with the Aleo `add` instruction. This is a Leo v3.5 constraint, not a LionDen issue.

## Migration Notes: v3.5 to v4

Users can deploy with Leo v3.5, migrate source to v4 syntax, and upgrade seamlessly:

1. Deploy the v3.5 program (edition 0).
2. Convert source to v4 syntax: `fn` keyword, `-> Final` returns, non-async `constructor`, inline `return final { ... }` blocks, `::` cross-program calls.
3. Update config: set `leoVersion` to a `4.0.x` patch such as `"4.0.0"`, remove or update `leoBinary`.
4. Run `upgrade` — LionDen recompiles with v4, validates ABI compatibility and constructor fingerprint, broadcasts the upgrade.

The `@admin` constructor fingerprint (`assert.eq program_owner <addr>;`) is identical in v3.5 and v4 compiled output, so the fingerprint check passes across versions. On-chain state (mappings) is preserved through the upgrade.

## Implementation Notes

These details are relevant to contributors working on the compiler and deploy pipelines:

- **ABI normalization.** v3.5 ABI uses `"transitions"` (v4: `"functions"`), `"is_async"` (v4: `"is_final"`), and bare `"Future"` output type (v4: `"Final"`). The ABI parser normalizes both formats to the same internal representation.

- **Constructor parsing.** v3.5 constructors use `async constructor()` syntax (e.g., `@noupgrade async constructor() {}`). The constructor parser accepts an optional `async` keyword before `constructor` in all four annotation patterns.

- **Import discovery.** v3.5 cross-program calls use slash-path syntax (`counter_store.aleo/increment(...)`) rather than v4's `::` syntax. The import parser scans for both `/([\w]+\.aleo)\//g` and `/([\w]+\.aleo)::/g`.

- **Compiled bytecode.** v3.5 and v4 produce structurally identical `main.aleo` output: same `function`/`finalize` sections, same `constructor:` block layout, same `.future` dispatch. The v4 devnode accepts v3.5-compiled bytecode without issue.

- **SDK compatibility.** `@provablehq/sdk@^0.10.5` builds and submits transactions for v3.5-compiled bytecode without modification. The SDK has no consensus-heights concept.

- **Managed Leo invocations.** LionDen passes `--disable-update-check` before every managed Leo command (`--version`, `build`, and `devnode start`). This is fixed behavior, not a user-configurable setting.
