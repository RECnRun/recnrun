import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

/** The Vitest Browser Mode project of one app under `dir`: Preact, the `@/` alias, headed Chromium. */
export function browserProject(name: string, dir: URL) {
  return defineConfig({
    root: fileURLToPath(dir),
    plugins: [preact()],
    optimizeDeps: {
      include: ["preact", "preact/hooks", "preact/jsx-runtime"],
    },
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", dir)) },
    },
    test: {
      fileParallelism: false,
      maxWorkers: 1,
      name: `${name}-browser`,
      include: ["tests/**/*.browser.test.{ts,tsx}"],
      browser: {
        enabled: true,
        provider: playwright(),
        headless: false,
        screenshotDirectory: fileURLToPath(new URL(`../../test-results/components/${name}`, dir)),
        instances: [{ browser: "chromium" }],
      },
    },
  });
}
