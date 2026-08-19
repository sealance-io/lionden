import { defineConfig } from "@lionden/config";
import base from "./lionden.config.js";

/**
 * The SDK arm of the multi-program case in `scripts/verify-deploy-backends.mjs`.
 *
 * This example is the one with a real local dependency chain
 * (`math_utils <- treasury <- rewards`), which is what makes it the case that
 * proves the Leo backend emits one `--skip` per local dependency and still
 * produces one record per program. See the hello-world variant for why
 * `ephemeral: false` and a dedicated `deploymentsDir` are load-bearing.
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
