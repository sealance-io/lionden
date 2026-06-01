import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.0.0",
  leoBinary: process.env["LIONDEN_LEO_4_0_BINARY"] ?? "leo",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  testing: { timeout: 240_000 },
  codegen: {
    dynamicRecords: {
      asGoldToken: {
        sourceProgram: "gold_token.aleo",
        sourceRecord: "Token",
        schema: {
          owner: "address.private",
          amount: "u64.private",
          purity: "u64.private",
          _nonce: "group.public",
        },
      },
      asSilverToken: {
        sourceProgram: "silver_token.aleo",
        sourceRecord: "Token",
        schema: {
          owner: "address.private",
          amount: "u64.private",
          grade: "u64.private",
          _nonce: "group.public",
        },
      },
    },
  },
});
