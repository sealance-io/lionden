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
  },
  // The @admin address in admin_example.aleo is devnode account-0, so map
  // the "admin" named account to that index. plugin-deploy reads
  // lre.namedAccounts["admin"] to pick the upgrade signer.
  namedAccounts: {
    admin: { default: 0 },
  },
  testing: { timeout: 180_000 },
});
