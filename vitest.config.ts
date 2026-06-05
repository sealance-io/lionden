import { defineConfig } from "vitest/config";

const unitTests = ["packages/*/src/**/*.test.ts"];
const contractTests = ["packages/*/src/**/*.contract.test.ts"];
const coverageOnlyExcludes = [
  "packages/test-internals/src/**/*.ts",
  "packages/*/src/**/__goldens__/**",
];

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        ...unitTests,
        ...contractTests,
        ...coverageOnlyExcludes,
        "packages/*/src/**/*.d.ts",
      ],
      reporter: ["text-summary", "html", "lcov"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: unitTests,
          exclude: contractTests,
        },
      },
      {
        test: {
          name: "contract",
          include: contractTests,
        },
      },
    ],
  },
});
