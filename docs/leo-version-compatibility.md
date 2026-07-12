# Leo Version Compatibility

## Supported Versions

| Version | Status | Scope |
|---------|--------|-------|
| Leo 4.3.x | Default (4.3.2), full support | snarkVM 4.8.1 → consensus **V16/V17**: larger program size limits (2048 kB program / 2304 kB deployment), quadratic deploy storage fee above 512 kB, the `ComponentChecksum` operand, and the finalize-time block spend limit. Language surface is unchanged from 4.2 (4.3.0 was the only breaking release: it requires a constructor per source program, which LionDen's deployable templates already emit). |
| Leo 4.2.x | Supported | Slimmer JSON ABI (positional inputs, dropped `is_final`/`const_parameters`/`implements`), explicit self-program refs, single-program `build/<program>/` layout |
| Leo 4.1.x | Supported | Explicit compatibility line; per-unit build layouts and `lib.leo` library units |
| Leo 4.0.x | Supported | Explicit compatibility line for projects staying on the previous Leo v4 line |
| Leo 3.5.x | Supported | Deployable `main.leo` programs only |

## Leo v3.5 Support Scope

Leo v3.5.x programs can be compiled, deployed, upgraded, and executed through LionDen. Cross-program calls work. The full deploy and upgrade lifecycle is supported. Upgrade correctness (ABI compatibility, constructor immutability, edition continuity) is owned by Leo's built-in tooling; LionDen's `upgrade` task recompiles, builds the upgrade transaction, broadcasts it, and records the result.

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

- **`leoVersion`** — compatibility declaration, not a binary pin. Accepted stable patch versions are `4.3.x` (default line, default value `"4.3.2"`), `4.2.x`, `4.1.x`, `4.0.x`, and `3.5.x`.
- **`leoBinary`** — path to the Leo CLI binary that LionDen actually executes. Defaults to `"leo"` (resolved from `PATH`). Tilde (`~/`) is expanded to the user's home directory during config resolution, since `execFile`/`spawn` do not perform shell expansion.
- **`skipLeoVersionCheck`** — default `false`. When `true`, LionDen still verifies that `leoBinary --disable-update-check --version` runs successfully, but skips parsing and comparing the version output. The configured `leoVersion` must still be a stable `major.minor.patch` string.

Install both Leo versions side-by-side with `leo update --name v3.5.0` (available since Leo v3.2.0). The default `leo` on `PATH` remains v4; point `leoBinary` at the named v3.5 installation.

The `examples/aleo-ports` smoke lane targets the default Leo 4.3.x line. Those configs pin `leoVersion: "4.3.2"` and use the `leo` binary resolved from `PATH`.

Before LionDen-managed compilation or devnode startup, LionDen runs the configured Leo binary with update checks disabled:

```bash
leo --disable-update-check --version
```

When version checking is enabled, the first stable `major.minor.patch` version in the output is compared against the configured `leoVersion` major/minor line. Patch drift is allowed: for example, `leoVersion: "4.0.0"` accepts a `leo 4.0.2` binary, and `leoVersion: "4.3.2"` accepts any `leo 4.3.x` binary. Minor drift is not allowed unless `skipLeoVersionCheck: true` is set. Missing or inaccessible binaries always fail preflight.

## Devnode Consensus Heights

> **`consensusHeights` is a Leo < 4.3 field.** Leo 4.3 removed `--consensus-heights` and `--network` from `leo devnode start`. The Leo 4.3+ devnode is `Ledger<TestnetV0>`-hardcoded and auto-activates the latest consensus version — including **V16 and V17** — with no flag. On Leo 4.3+, LionDen omits both flags and **rejects** a `consensusHeights` (or non-`testnet` `network`) at config validation so nothing is silently dropped.

Constructor programs (ARC-0006: `@noupgrade`, `@admin`, etc.) require `ConsensusVersion::V9`. The Leo v4 devnode activates V9 by default. The Leo v3.5 devnode does not — constructor deploys fail with _"program uses syntax that is not allowed before ConsensusVersion::V9"_ unless `--consensus-heights` is passed.

On Leo **< 4.3**, LionDen exposes this as an explicit opt-in field on devnode network config:

```typescript
networks: {
  devnode: {
    type: "devnode",
    consensusHeights: "0,1,2,3,4,5,6,7,8", // Leo < 4.3 only
  },
}
```

The value is comma-delimited block heights at which each consensus version activates (length = target version). LionDen does not default this field — it matches the Leo CLI's own default behavior. V4 projects on Leo < 4.3 do not need it. V3.5 projects deploying constructor programs must set it explicitly. On Leo 4.3+ the field is unsupported (the devnode auto-activates all consensus versions).

`consensusHeights` applies to the **Leo < 4.3 backend only**. The standalone `aleo-devnode` backend (`provider: "standalone"`) is TestnetV0-only with consensus heights compiled in, so it rejects any `consensusHeights`.

Both managed devnode backends should be treated as testnet-like local chains. The standalone backend rejects a non-`testnet` `network`; the Leo < 4.3 backend accepts a `network` field for CLI compatibility (Leo 4.3+ is TestnetV0-only and rejects non-`testnet`), but the local devnode still behaves as testnet in practice. Use an `http` network entry when you need to target a real testnet, mainnet, canary, or a user-operated node. See the backend-selection section of [`network.md`](network.md#devnode-lifecycle).

### Consensus V16/V17 on the Leo 4.3+ devnode

The Leo 4.3.2 devnode advances through the SDK's consensus test heights, which end at **V17** (V16 rules active plus the V17 anchor-time revert). Local devnode coverage of V16/V17 is therefore automatic once Leo is 4.3.2 — no `--consensus-heights` needed. This differs from **public TestnetV0**, where V17 is set to `u32::MAX` (disabled); a real testnet never activates V17. Block-wide deployment density limits and `deployment_cost_v4` are staged for V18, not V17, and are absent from snarkVM 4.8.1.

## Compatibility Matrix

| Scenario | Supported |
|----------|-----------|
| Compile v3.5 deployable program | Yes |
| Compile v4.1 program build layout | Yes |
| Deploy v3.5 bytecode to v4-class devnode/network | Yes |
| v3.5 → v3.5 upgrade (same compiler) | Yes |
| v3.5 → v4 migration upgrade (`@admin` path) | Yes |
| v3.5 cross-program calls (slash-path syntax) | Yes |
| v3.5 `lib.leo` library units | No |

## Known Limitations

1. **`lib.leo` not supported.** Leo v3.5 cannot compile library-shaped packages. Projects needing shared library units must use Leo v4.

2. **`@admin` is the exercised upgrade path.** The v3.5 → v4 migration upgrade was exercised with `@admin` constructors. Other constructor types (`@checksum`, `@custom`) compile correctly but have not been run through a full cross-version upgrade probe. The constructor decorator remains required Leo syntax in either case.

3. **`add` is a reserved opcode in v3.5.** A Leo function named `add` conflicts with the Aleo `add` instruction. This is a Leo v3.5 constraint, not a LionDen issue.

## Migration Notes: v3.5 to v4

Users can deploy with Leo v3.5, migrate source to v4 syntax, and upgrade seamlessly:

1. Deploy the v3.5 program (edition 0).
2. Convert source to v4 syntax: `fn` keyword, `-> Final` returns, non-async `constructor`, inline `return final { ... }` blocks, `::` cross-program calls.
3. Update config: set `leoVersion` to the default v4 line such as `"4.3.2"` (or an explicit `4.2.x`/`4.1.x`/`4.0.x` patch if you are intentionally staying on an earlier Leo v4 line), then remove or update `leoBinary`.
4. Run `upgrade` — LionDen recompiles with v4, builds the upgrade transaction, broadcasts it, and records the result. Upgrade correctness is enforced by Leo's built-in tooling.

The `@admin` constructor (`assert.eq program_owner <addr>;`) compiles to identical output in v3.5 and v4, so the upgrade is accepted across versions. On-chain state (mappings) is preserved through the upgrade.

## Implementation Notes

These details are relevant to contributors working on the compiler and deploy pipelines:

- **ABI normalization (multi-version, shape-detecting).** The parser accepts three wire shapes and normalizes all to one internal representation: v3.5 (`"transitions"`/`"is_async"`/bare `"Future"`), Leo 4.1 / bytecode `leo abi` (I/O wrapped as `{ name?, ty, mode }`, `"functions"`/`is_final`/`"Final"`), and Leo 4.2 (I/O elements are the bare enum variant — `{ Plaintext: { ty, mode } }`, `{ Record: { path, program } }`, `"Final"`, `"DynamicRecord"` — with input names dropped). It detects per-element which shape applies (the top-level `ty` key marks the 4.1/internal wrapper, so a 4.1 input literally named `Plaintext` is not misread). Re-parsing an already-normalized ABI is a fixed point.
- **Leo 4.2 ABI changes (intentional breaking change).** Leo 4.2 emits a slimmer ABI: input names removed (the parser synthesizes positional `arg0`, `arg1`, … only when absent and preserves existing names), `is_final` removed (async/has-finalize is inferred from a `Final` output), and `const_parameters` / `Program.implements` removed. `Mode::None` is gone — the parser canonicalizes unmoded/`None` plaintext to `Private` (transitions and record-definition fields) or `Public` (views), and the `Mode` union drops `None` and adds `Constant`. Record/`Final`/`DynamicRecord` carry no mode. Self type references are now explicit (`program: "<self>.aleo"`); the parser rewrites them back to `program: null` across **every** plaintext surface (struct/record definitions, mappings, storage variables, and function/view I/O) so a 4.1 self-ref (`null`) and a 4.2 self-ref compare equal.
- **Leo 4.3 ABI shape (record-field modes only).** The Leo 4.3 wire ABI is identical to 4.2 except record-**definition** fields now carry an explicit `mode` (always `"Private"`; struct fields, mappings, and function I/O are unchanged). This is a no-op for LionDen: `canonicalizeRecordFieldMode` already maps both the 4.2 absent mode and the 4.3 explicit `Private` to `Private`, so a 4.2 and a 4.3 ABI for the same program normalize byte-for-byte identically. The `token-v43` golden fixture (`packages/leo-compiler/src/__fixtures__/abi/` + `__goldens__/abi/`, wired via `FIXTURE_PAIRS` in `abi-parser.golden.test.ts`) locks this in against real 4.3.2 `leo build` output.
- **Build layout.** The compiler builds every unit as a standalone single-program package, and `resolveBuildArtifacts` probes `build/`, `build/<id>/`, and `build/<base>/` for both `<program>.aleo`/`main.aleo` and `abi.json` — covering the Leo 4.2 single-program `build/<program>/` layout as well as the Leo 4.1 per-unit and legacy `build/main.aleo` layouts. Program artifacts normalize back to `artifacts/<programId>/abi.json` and `main.aleo`.
- **Build flags (version-gated).** Leo 4.2 removed the `--enable-dce` and `--conditional-block-max-depth` flags from `leo build` (dead-code elimination is now unconditional). The compiler emits them only when the configured `leoVersion` is below 4.2 — the `compiler.enableDce` and `compiler.conditionalBlockMaxDepth` config options are therefore no-ops on the 4.2.x and later lines. An unparseable/unknown `leoVersion` is treated as modern (4.2+) and omits both, since passing a removed flag is a hard `leo build` failure.
- **Deploy rename (version-gated).** `lionden deploy --program <source> --rename <target>` is available only for `leoVersion >= 4.3.0`. It is deploy-only: the public `compile` task does not expose rename, and LionDen keeps the SDK deploy path rather than shelling out to `leo deploy`. The compiler's materialized package rewrites only the primary program declaration for the deploy build; imports remain unchanged. Generated typechain wrappers can target renamed deployments with `createX({ programId: "<target>.aleo" })` while retaining `sourceProgramId` for the generated source identity.
- **Devnode flags (version-gated).** Leo 4.3 removed `--consensus-heights` and `--network` from `leo devnode start` (`DevnodeManager.buildLeoArgs` emits them only for Leo < 4.3, mirroring the build-flag gate). The Leo 4.3+ devnode is TestnetV0-only and auto-activates the latest consensus version, so `plugin-network`'s `validateResolvedConfig` rejects a `consensusHeights` / non-`testnet` `network` on the leo (or auto-detected) provider when `leoVersion >= 4.3`, rather than dropping them silently. An unparseable/unset `leoVersion` is treated as modern (>= 4.3).
- **Leo 4.1 ABI extensions.** `views`, `implements`, and non-empty `const_parameters` are parsed and surfaced in the ABI only when present. Generated TypeScript wrappers still emit execution methods for transitions only; view query wrappers are deferred, and executable functions with non-empty `const_parameters` fail codegen explicitly.

- **Constructor syntax.** v3.5 constructors use `async constructor()` syntax (e.g., `@noupgrade async constructor() {}`), while v4 drops the `async` keyword. The constructor decorator (`@noupgrade`/`@admin`/`@checksum`/`@custom`) is required Leo source in both versions and is what Leo's own tooling uses to enforce upgrade rules.

- **Import discovery.** v3.5 cross-program calls use slash-path syntax (`counter_store.aleo/increment(...)`) rather than v4's `::` syntax. The import parser scans for both `/([\w]+\.aleo)\//g` and `/([\w]+\.aleo)::/g`.

- **Compiled bytecode.** v3.5 and v4 produce structurally identical `main.aleo` output: same `function`/`finalize` sections, same `constructor:` block layout, same `.future` dispatch. The v4 devnode accepts v3.5-compiled bytecode without issue.

- **SDK compatibility.** `@provablehq/sdk@^0.11.3` (snarkVM 4.8.1) builds and submits transactions for v3.5- through v4.3-compiled bytecode without modification. For devnode connections the SDK derives its own consensus test heights via `getOrInitConsensusVersionTestHeights()` (ending at V17), independent of any Leo `--consensus-heights` flag.

- **Managed Leo invocations.** LionDen passes `--disable-update-check` before every managed Leo command (`--version`, `build`, and `devnode start`). This is fixed behavior, not a user-configurable setting.
