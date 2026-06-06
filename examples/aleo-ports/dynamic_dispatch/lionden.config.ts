import { defineConfig } from "@lionden/config";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.1.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  testing: { timeout: 240_000 },
  execution: {
    imports: {
      "governance.aleo": ["voting_power.aleo", "quadratic_power.aleo"],
    },
  },
});
