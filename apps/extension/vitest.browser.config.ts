import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [preact()],
  optimizeDeps: {
    include: ["preact", "preact/hooks", "preact/jsx-runtime"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    name: "extension-browser",
    include: ["tests/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: false,
      screenshotDirectory: fileURLToPath(
        new URL("../../test-results/components/extension", import.meta.url),
      ),
      instances: [{ browser: "chromium" }],
    },
  },
});
