import { defineConfig } from "@lionden/config";

export default defineConfig({
  leoVersion: "4.0.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  compiler: { enableDce: true },
  testing: { timeout: 120_000 },
});
