---
---

Intentionally empty: no package has been published yet, so this releases nothing and folds into
the initial (pre-v1, ~0.1.0) publish.

Consolidates `--prove` into one mental model — *"`--prove` anywhere (or a truthy `LIONDEN_PROVE`)
forces standard/proven builders; `--prove=false` reliably disables it everywhere"* — with local
opt-outs where tests need mixed control:

- **`--prove` is now a framework built-in global** (like `--network`), resolved in any position for
  `deploy`, `upgrade`, `recipe`, and `test`. It is no longer a `plugin-deploy` global or a `test`
  task flag. The name `prove` is now **reserved**: a plugin global or task argument that shadows it
  is rejected at load/build time.
- **`test` honours an ambient `LIONDEN_PROVE`** (consistent with deploy/upgrade); an explicit
  `--prove`/`--prove=false` wins, and when the env is the source the run prints
  `Proving enabled via LIONDEN_PROVE`. The resolved value is canonicalized (or cleared) **before**
  suite-setup hooks run, so hooks and Vitest workers see the same value.
- **Permissive env parsing** via the new `parseBooleanEnv` helper (exported from `@lionden/config`):
  runtime readers accept `1`/`yes`/`on`/… for `LIONDEN_PROVE`. Generated typechain wrappers
  intentionally keep the strict `=== "true"` check this pass; CLI test runs are unaffected because
  the env is canonicalized to `"true"`.
- **New per-call prove escape hatches**: `prove?: boolean` on testing `ExecuteOptions`
  (`ctx.execute`), recipe `RecipeExecuteOptions` (`ctx.execute`) and `RecipeDeployOptions`
  (`ctx.deploy`). Programmatic `runTests({ prove })` now distinguishes `undefined` (honor ambient
  env) from explicit `false` (clear).

Since none of this ever shipped, there is no consumer-facing breaking change to flag — these are
corrections to the not-yet-published API (breaking changes are expected pre-v1).
