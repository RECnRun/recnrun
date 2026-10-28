import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { contentSecurityPolicy } from "./build/content-security-policy.ts";

export default defineConfig({
  plugins: [preact(), contentSecurityPolicy()],
  // The dev extension opens this exact URL, so the port must not drift.
  server: { port: 5173, strictPort: true },
  // The policy is its own file, so GitHub Pages answers /privacy/ with 200 instead of 404.html.
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        privacy: fileURLToPath(new URL("./privacy/index.html", import.meta.url)),
      },
    },
  },
  test: {
    name: "website",
    isolate: false,
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
