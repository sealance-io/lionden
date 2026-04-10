import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["**/*.contract.test.ts"],
        },
      },
      {
        test: {
          name: "contract",
          include: ["packages/*/src/**/*.contract.test.ts"],
        },
      },
    ],
  },
});
