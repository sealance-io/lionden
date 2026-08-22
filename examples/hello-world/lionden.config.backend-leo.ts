import { defineConfig } from "@lionden/config";
import base from "./lionden.config.js";

/** The Leo arm of `scripts/verify-deploy-backends.mjs`. See the sdk variant. */
export default defineConfig({
  ...base,
  deploy: {
    ...base.deploy,
    backend: "leo",
    ephemeral: false,
    deploymentsDir: "deployments-leo",
  },
});
