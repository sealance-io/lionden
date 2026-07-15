import { defineConfig } from "@lionden/config";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.3.2",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  namedAccounts: {
    deployer: { default: 0 },
    admin: { default: 0 },
  },
  testing: { timeout: 240_000 },
  execution: {
    imports: {
      "token_router.aleo": ["tenant_gold.aleo"],
    },
  },
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
    },
  },
});
