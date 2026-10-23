import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { contentSecurityPolicy } from "./build/content-security-policy.ts";
import { notFoundPage } from "./build/not-found-page.ts";

export default defineConfig({
  plugins: [preact(), contentSecurityPolicy(), notFoundPage()],
  // The dev extension opens this exact URL, so the port must not drift.
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
