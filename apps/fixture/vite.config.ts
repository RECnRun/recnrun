import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    name: "fixture",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@scripts": fileURLToPath(new URL("./scripts", import.meta.url)),
    },
  },
});
