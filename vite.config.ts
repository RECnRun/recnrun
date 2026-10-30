import { defineConfig } from "vite-plus";

const testFiles = ["**/tests/**", "**/*.test.{ts,tsx}", "**/*.spec.ts", "**/*.checks.mjs"];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["**/.output/**", "**/.wxt/**"],
  },
  lint: {
    ignorePatterns: ["**/.output/**", "**/.wxt/**"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "sonarjs", specifier: "eslint-plugin-sonarjs" },
    ],
    rules: {
      complexity: ["error", 10],
      "sonarjs/cognitive-complexity": ["error", 15],
      "max-depth": ["error", 3],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 4],
      "max-nested-callbacks": ["error", 3],
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/ban-ts-comment": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        files: ["apps/*/src/**", "apps/*/tests/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [{ regex: "^\\.\\./", message: "Import app source through the @/ alias." }],
            },
          ],
        },
      },
      {
        // The content script runs inside web pages; it reaches stored data only through the background.
        files: ["apps/extension/src/content/**"],
        rules: {
          "no-restricted-properties": [
            "error",
            {
              object: "browser",
              property: "storage",
              message: "The content script never touches storage; ask the background.",
            },
          ],
        },
      },
      {
        // describe/test callbacks group many cases; production code keeps the stricter caps.
        files: testFiles,
        rules: {
          "max-lines-per-function": [
            "error",
            { max: 150, skipBlankLines: true, skipComments: true },
          ],
          "max-nested-callbacks": ["error", 4],
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    projects: [
      "apps/website",
      "apps/extension",
      "packages/domain",
      "packages/bridge",
      "apps/website/vitest.browser.config.ts",
      "apps/extension/vitest.browser.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
  run: {
    cache: { scripts: false, tasks: true },
    tasks: {
      test: {
        cache: false,
        command: "node scripts/test-container.mjs test:local",
      },
      "test:local": {
        cache: false,
        command: [
          "vp run --no-cache test:unit:local",
          "vp run --no-cache test:components:local",
          "vp run --no-cache test:e2e:local",
        ],
      },
      verify: {
        cache: false,
        command: "node scripts/test-container.mjs verify:local",
      },
      "verify:local": {
        cache: false,
        command: [
          "vp check",
          "vp lint --deny-warnings",
          "vp run --no-cache deps",
          "vp run --no-cache test:local",
          "vp run --no-cache test:container",
          "vp run --no-cache test:hooks",
          "vp run --no-cache test:coverage:local",
          "vp run --no-cache dead-code",
          "vp run --no-cache duplication",
          "vp run -r --no-cache build",
          "vp run --no-cache test:extension-manifest",
        ],
      },
    },
  },
});
