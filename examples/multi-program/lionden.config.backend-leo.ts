import { defineConfig } from "@lionden/config";
import base from "./lionden.config.js";

/** The Leo arm of the multi-program case. See the sdk variant. */
export default defineConfig({
  ...base,
  deploy: {
    ...base.deploy,
    backend: "leo",
    ephemeral: false,
    deploymentsDir: "deployments-leo",
  },
});
