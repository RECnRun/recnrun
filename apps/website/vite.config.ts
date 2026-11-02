import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { contentSecurityPolicy } from "./build/content-security-policy.ts";

export default defineConfig({
  plugins: [preact(), contentSecurityPolicy()],
  // Docs and AGENTS.md name this port; fail rather than drift to another one.
  server: { port: 5173, strictPort: true },
  test: {
    name: "website",
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["**/*.browser.test.{ts,tsx}", "**/node_modules/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@build": fileURLToPath(new URL("./build", import.meta.url)),
    },
  },
});
