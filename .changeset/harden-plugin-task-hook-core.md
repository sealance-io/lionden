---
---

Intentionally empty: no package has been published yet, so this releases nothing and folds into
the initial (pre-v1, ~0.1.0) publish.

Hardens and slims the plugin / task / hook core. Removed never-wired surface (`LionDenPlugin.conditionalDependencies`, `TaskBuilder.setLazyAction` + the lazy-factory `TaskDefinition.action` union, `HookDispatcher.parallel`, and the `"compilation"` / `"network"` hook categories with their `Compilation*` / `Network*` types — `HookCategory` is now `"config" | "testing" | "deployment"`); added `HookDispatcher.collect()` and routed the config lifecycle through the shared `HookDispatcherImpl`; the task runner now binds positional arguments by name and enforces `required` positionals; and `@lionden/plugin-deploy` first introduced a `--prove` global (since superseded — `--prove` is now a framework built-in global; see the `--prove` consolidation changeset).

Since none of this ever shipped, there is no consumer-facing breaking change to flag — these are corrections to the not-yet-published API.
