import { defineConfig } from "@lionden/config";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.0.0",
  leoBinary: process.env["LIONDEN_LEO_4_0_BINARY"] ?? "leo",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  testing: { timeout: 180_000 },
});
