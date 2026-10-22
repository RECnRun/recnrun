import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { WxtVitest } from "wxt/testing/vitest-plugin";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  // WXT resolves its config, aliases, and fake browser from the root it is given.
  plugins: [WxtVitest({ root })],
  test: {
    name: "extension",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.browser.test.{ts,tsx}", "**/node_modules/**"],
  },
});
