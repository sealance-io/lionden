import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.0.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
    // Example: multi-network config with configVariable().
    // Uncomment and set ALEO_PRIVATE_KEY in your environment to deploy to testnet:
    //
    // import { configVariable } from "@lionden/config";
    // testnet: {
    //   type: "http",
    //   endpoint: "https://api.explorer.provable.com/v1",
    //   network: "testnet",
    //   privateKey: configVariable("ALEO_PRIVATE_KEY"),
    // },
  },
  testing: { timeout: 120_000 },
  deploy: { confirmTransactions: true },
});
