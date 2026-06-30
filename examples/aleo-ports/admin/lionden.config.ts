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
  // Signer selection (lionden does no address-match validation, it only
  // *selects* a key by role): deploy picks namedAccounts.deployer, upgrade
  // picks namedAccounts.admin. The @admin address in admin_example.aleo is
  // devnode account-0, so map both roles to index 0.
  namedAccounts: {
    deployer: { default: 0 },
    admin: { default: 0 },
  },
  testing: { timeout: 180_000 },
});
