---
---

Intentionally empty: no package has been published yet, so this releases nothing and folds into
the initial (pre-v1, ~0.1.0) publish.

Publish-readiness metadata for the first npm release. Every publishable package gains
`license: "Apache-2.0"`, `publishConfig.access: "public"`, an `engines.node` range matching the
repo requirement (`^20.19.0 || >=22.12.0`), and a `files` negation (`"!dist/**/*.test.*"`) that
keeps compiled test artifacts out of the tarballs. Each package also ships its own `README.md`
and `LICENSE` (npm does not inherit root files into workspace tarballs). No runtime code changed.
