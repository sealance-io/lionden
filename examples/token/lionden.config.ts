import { defineConfig } from "@lionden/config";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.2.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
    // testnet: {
    //   type: "http",
    //   endpoint: "https://api.explorer.provable.com/v1",
    //   network: "testnet",
    //   privateKey: configVariable("DEPLOYER_KEY"),
    // },
  },
  namedAccounts: {
    deployer: {
      default: 0,
      // testnet: configVariable("DEPLOYER_KEY"),
    },
    treasury: {
      default: "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5",
    },
  },
  testing: { timeout: 120_000 },
  deploy: { confirmTransactions: true },
});
