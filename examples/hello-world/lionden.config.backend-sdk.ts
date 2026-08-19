import { defineConfig } from "@lionden/config";
import base from "./lionden.config.js";

/**
 * The SDK arm of `scripts/verify-deploy-backends.mjs`.
 *
 * Extends the example's real config so the two arms cannot drift from it or
 * from each other — only `deploy` differs, and only in the three fields the
 * parity run needs.
 *
 * `ephemeral: false` is mandatory, not incidental. The example declares
 * `devnode: { type: "devnode", autoBlock: true }` with no `ephemeral`, and
 * `resolveNetworkConfig` defaults devnode networks to ephemeral. `record()`
 * writes nothing when ephemeral, so without this the driver would compare two
 * empty directories and pass vacuously.
 *
 * `deploymentsDir` is config-only — there is no env override — so the isolation
 * between the two arms has to come from committed files rather than the shell.
 */
export default defineConfig({
  ...base,
  deploy: {
    ...base.deploy,
    backend: "sdk",
    ephemeral: false,
    deploymentsDir: "deployments-sdk",
  },
});
