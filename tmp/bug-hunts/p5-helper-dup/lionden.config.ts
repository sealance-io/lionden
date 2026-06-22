import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.1.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  testing: { autoStartDevnode: false, timeout: 120_000 },
  // Helper named to collide with the external record value binding the consumer
  // also emits for `gold_token.aleo::Token` (alias `GoldToken_Token`). The helper
  // is routed to the consumer module because its sourceRecord `Receipt` is local
  // to consumer.aleo.
  codegen: {
    dynamicRecords: {
      GoldToken_Token: {
        sourceRecord: "Receipt",
        schema: {
          owner: "address.private",
          amount: "u64.private",
          _nonce: "group.private",
        },
      },
    },
  },
});
