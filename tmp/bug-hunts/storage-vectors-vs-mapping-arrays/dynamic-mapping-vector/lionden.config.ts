import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork],
  leoVersion: "4.1.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: {
      type: "devnode",
      socketAddr: "127.0.0.1:3030",
      autoBlock: true,
      network: "testnet",
    },
  },
});
